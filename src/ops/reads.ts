import { sql, type SQL } from 'drizzle-orm';
import type { DB } from '../db';
import { shiftYmd } from '../lib/format';

// Drizzle returns different row shapes for raw sql`...` depending on driver:
//   - D1 binding (Worker runtime)        → rows are OBJECTS keyed by column
//   - sqlite-proxy /raw (MCP server)     → rows are positional ARRAYS
// Detect and normalize either way using the explicit column list.
async function rows<T>(d: DB, query: SQL, cols: readonly string[]): Promise<T[]> {
  const raw = (await d.all(query)) as unknown[];
  return raw.map((r) => {
    if (Array.isArray(r)) {
      const o: Record<string, unknown> = {};
      cols.forEach((c, i) => (o[c] = r[i]));
      return o as T;
    }
    return r as T;
  });
}

const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v ?? 0));

// === Private-investment value derivation ============================
//
// The single source of truth for what a private investment is worth at
// time t. Rule:
//
//   1. If there's an asset-level manual override (investment_id IS NULL,
//      as_of ≤ t), the latest such override IS the total value. Done.
//      Used for funds, non-share holdings ("Grandma $50k"), and for
//      replacing a PPS-derived total with a conservative estimate.
//
//   2. Otherwise, sum across FUNDED rounds with entry_date ≤ t. Per round:
//        - Per-round manual override (investment_id = round.id, as_of ≤ t)
//          takes precedence if present.
//        - Else, if the asset has any round with PPS and entry_date ≤ t,
//          value = round.shares × latest_round_PPS. "Last round sets the
//          mark" — applies equally to mark-ups and down-rounds.
//        - Else, fall back to round.cost_basis_cents (unconverted
//          SAFE/note or other PPS-less round).
//
// Pending (funded_at IS NULL) rounds DO contribute their PPS to the
// latest-round mark — the round is happening regardless of whether our
// wire has cleared, and existing shares are now worth the new price. They
// do NOT contribute their own shares/cost-basis to current value or cost
// basis; that capital is "uncalled" and tracked separately.
//
// Auto-generated marks don't exist in this model. Every row in
// `valuations` is an intentional manual signal.

type RoundInput = {
  id: string;
  asset_id: string;
  security_type: string | null;
  round_label: string | null;
  shares: number | null;
  pps_cents: number | null;
  cost_basis_cents: number;
  entry_date: number;
  funded_at: number | null;
};

type ValuationInput = {
  id: string;
  asset_id: string;
  investment_id: string | null;
  as_of: number;
  value_cents: number;
  basis: string | null;
};

type DerivedAssetValue = {
  total_cents: number;
  asset_level_override: boolean;
  per_round: Map<string, number>;
};

function deriveAssetValue(
  rounds: RoundInput[],
  valuations: ValuationInput[],
  at_sec: number,
): DerivedAssetValue {
  const assetLevel = valuations
    .filter((v) => v.investment_id == null && v.as_of <= at_sec)
    .reduce<ValuationInput | null>((best, v) => (!best || v.as_of >= best.as_of ? v : best), null);
  if (assetLevel) {
    return {
      total_cents: assetLevel.value_cents,
      asset_level_override: true,
      per_round: new Map(),
    };
  }

  const activeRounds = rounds.filter((r) => r.entry_date <= at_sec);
  if (activeRounds.length === 0) {
    return { total_cents: 0, asset_level_override: false, per_round: new Map() };
  }

  // Latest PPS uses ALL active rounds (funded + pending). The pending C round
  // is real evidence of the new mark even before our wire clears.
  const latestPPSRound = activeRounds
    .filter((r) => r.pps_cents != null)
    .reduce<RoundInput | null>((best, r) => (!best || r.entry_date >= best.entry_date ? r : best), null);
  const latestPPSCents = latestPPSRound?.pps_cents ?? null;

  // Value contributions only count for funded rounds — uncalled capital
  // doesn't add to current value (the cash hasn't moved).
  const perRound = new Map<string, number>();
  let total = 0;
  for (const r of activeRounds) {
    if (r.funded_at == null) continue;
    const override = valuations
      .filter((v) => v.investment_id === r.id && v.as_of <= at_sec)
      .reduce<ValuationInput | null>((best, v) => (!best || v.as_of >= best.as_of ? v : best), null);
    let value: number;
    if (override) {
      value = override.value_cents;
    } else if (r.shares != null && latestPPSCents != null) {
      value = Math.round(r.shares * latestPPSCents);
    } else {
      value = r.cost_basis_cents;
    }
    perRound.set(r.id, value);
    total += value;
  }
  return { total_cents: total, asset_level_override: false, per_round: perRound };
}

async function fetchRoundsAndValuations(
  d: DB,
  filter: { assetId?: string } = {},
): Promise<{
  rounds: RoundInput[];
  valuations: ValuationInput[];
}> {
  const roundsSql = filter.assetId
    ? sql`
        SELECT i.id, i.asset_id, i.security_type, i.round_label,
          i.shares, i.price_per_share_cents AS pps_cents,
          i.cost_basis_cents, i.entry_date, i.funded_at
        FROM investments i
        WHERE i.asset_id = ${filter.assetId} AND i.archived_at IS NULL
      `
    : sql`
        SELECT i.id, i.asset_id, i.security_type, i.round_label,
          i.shares, i.price_per_share_cents AS pps_cents,
          i.cost_basis_cents, i.entry_date, i.funded_at
        FROM investments i
        JOIN private_investments pi ON pi.id = i.asset_id
        WHERE i.archived_at IS NULL AND pi.archived_at IS NULL
      `;
  const valsSql = filter.assetId
    ? sql`
        SELECT v.id, v.asset_id, v.investment_id, v.as_of, v.value_cents, v.basis
        FROM valuations v WHERE v.asset_id = ${filter.assetId}
      `
    : sql`
        SELECT v.id, v.asset_id, v.investment_id, v.as_of, v.value_cents, v.basis
        FROM valuations v
        JOIN private_investments pi ON pi.id = v.asset_id
        WHERE pi.archived_at IS NULL
      `;
  const rRows = await rows<Record<string, unknown>>(
    d,
    roundsSql,
    ['id', 'asset_id', 'security_type', 'round_label', 'shares', 'pps_cents', 'cost_basis_cents', 'entry_date', 'funded_at'],
  );
  const vRows = await rows<Record<string, unknown>>(
    d,
    valsSql,
    ['id', 'asset_id', 'investment_id', 'as_of', 'value_cents', 'basis'],
  );
  return {
    rounds: rRows.map((r) => ({
      id: String(r.id),
      asset_id: String(r.asset_id),
      security_type: r.security_type == null ? null : String(r.security_type),
      round_label: r.round_label == null ? null : String(r.round_label),
      shares: r.shares == null ? null : num(r.shares),
      pps_cents: r.pps_cents == null ? null : num(r.pps_cents),
      cost_basis_cents: num(r.cost_basis_cents),
      entry_date: num(r.entry_date),
      funded_at: r.funded_at == null ? null : num(r.funded_at),
    })),
    valuations: vRows.map((v) => ({
      id: String(v.id),
      asset_id: String(v.asset_id),
      investment_id: v.investment_id == null ? null : String(v.investment_id),
      as_of: num(v.as_of),
      value_cents: num(v.value_cents),
      basis: v.basis == null ? null : String(v.basis),
    })),
  };
}

function groupByAsset<T extends { asset_id: string }>(xs: T[]): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of xs) {
    const arr = m.get(x.asset_id);
    if (arr) arr.push(x);
    else m.set(x.asset_id, [x]);
  }
  return m;
}

// ====================================================================

export async function netWorth(d: DB) {
  const [liqRow] = await rows<{ cents: number }>(
    d,
    sql`
      SELECT COALESCE(SUM(CASE WHEN a.is_liability THEN -bs.balance_cents ELSE bs.balance_cents END), 0) AS cents
      FROM accounts a
      JOIN balance_snapshots bs ON bs.id = (
        SELECT id FROM balance_snapshots WHERE account_id = a.id ORDER BY as_of DESC LIMIT 1
      )
      WHERE a.archived_at IS NULL
    `,
    ['cents'],
  );
  const liquidCents = num(liqRow?.cents);

  const now = Math.floor(Date.now() / 1000);
  const { rounds, valuations } = await fetchRoundsAndValuations(d);
  const assetsWithRounds = groupByAsset(rounds);
  const valsByAsset = groupByAsset(valuations);
  const assetIds = new Set([...assetsWithRounds.keys(), ...valsByAsset.keys()]);
  let privateCents = 0;
  for (const assetId of assetIds) {
    const { total_cents } = deriveAssetValue(
      assetsWithRounds.get(assetId) ?? [],
      valsByAsset.get(assetId) ?? [],
      now,
    );
    privateCents += total_cents;
  }

  const totalCents = liquidCents + privateCents;
  return {
    total_usd: totalCents / 100,
    liquid_usd: liquidCents / 100,
    private_usd: privateCents / 100,
    total_cents: totalCents,
    liquid_cents: liquidCents,
    private_cents: privateCents,
  };
}

type AccountRow = {
  id: string;
  institution: string;
  name: string;
  kind: string;
  currency: string;
  is_liability: number;
  source: string;
  owner: 'tyler' | 'julianne' | 'joint';
  note: string | null;
  latest_cents: number | null;
  latest_as_of: number | null;
};

export async function listAccounts(d: DB): Promise<AccountRow[]> {
  return rows<AccountRow>(
    d,
    sql`
      SELECT a.id, i.name AS institution, a.name, a.kind, a.currency, a.is_liability, a.source, a.owner, a.note,
        (SELECT balance_cents FROM balance_snapshots WHERE account_id = a.id ORDER BY as_of DESC LIMIT 1) AS latest_cents,
        (SELECT as_of        FROM balance_snapshots WHERE account_id = a.id ORDER BY as_of DESC LIMIT 1) AS latest_as_of
      FROM accounts a
      JOIN institutions i ON i.id = a.institution_id
      WHERE a.archived_at IS NULL
      ORDER BY i.name, a.name
    `,
    ['id', 'institution', 'name', 'kind', 'currency', 'is_liability', 'source', 'owner', 'note', 'latest_cents', 'latest_as_of'],
  );
}

type PrivateInvestmentRow = {
  id: string;
  kind: string;
  name: string;
  notes: string | null;
  owner: 'tyler' | 'julianne' | 'joint';
  stage: string | null;
  bear_pct: number | null;
  bull_pct: number | null;
  current_value_cents: number;
  total_cost_basis_cents: number;       // funded only (deployed capital)
  outstanding_cost_basis_cents: number; // pending wires (committed but uncalled)
  investment_count: number;
};

export async function listPrivateInvestments(d: DB): Promise<PrivateInvestmentRow[]> {
  const meta = await rows<{
    id: string;
    kind: string;
    name: string;
    notes: string | null;
    owner: 'tyler' | 'julianne' | 'joint';
    stage: string | null;
    bear_pct: number | null;
    bull_pct: number | null;
    total_cost_basis_cents: number;
    outstanding_cost_basis_cents: number;
    investment_count: number;
  }>(
    d,
    sql`
      SELECT pi.id, pi.kind, pi.name, pi.notes, pi.owner, pi.stage, pi.bear_pct, pi.bull_pct,
        (SELECT COALESCE(SUM(cost_basis_cents), 0) FROM investments
         WHERE asset_id = pi.id AND archived_at IS NULL AND funded_at IS NOT NULL) AS total_cost_basis_cents,
        (SELECT COALESCE(SUM(cost_basis_cents), 0) FROM investments
         WHERE asset_id = pi.id AND archived_at IS NULL AND funded_at IS NULL) AS outstanding_cost_basis_cents,
        (SELECT COUNT(*) FROM investments WHERE asset_id = pi.id AND archived_at IS NULL) AS investment_count
      FROM private_investments pi
      WHERE pi.archived_at IS NULL
      ORDER BY pi.kind, pi.name
    `,
    ['id', 'kind', 'name', 'notes', 'owner', 'stage', 'bear_pct', 'bull_pct', 'total_cost_basis_cents', 'outstanding_cost_basis_cents', 'investment_count'],
  );
  const now = Math.floor(Date.now() / 1000);
  const { rounds, valuations } = await fetchRoundsAndValuations(d);
  const roundsByAsset = groupByAsset(rounds);
  const valsByAsset = groupByAsset(valuations);
  return meta.map((row) => {
    const { total_cents } = deriveAssetValue(
      roundsByAsset.get(row.id) ?? [],
      valsByAsset.get(row.id) ?? [],
      now,
    );
    return {
      id: row.id,
      kind: row.kind,
      name: row.name,
      notes: row.notes,
      owner: row.owner,
      stage: row.stage == null ? null : String(row.stage),
      bear_pct: row.bear_pct == null ? null : num(row.bear_pct),
      bull_pct: row.bull_pct == null ? null : num(row.bull_pct),
      current_value_cents: total_cents,
      total_cost_basis_cents: num(row.total_cost_basis_cents),
      outstanding_cost_basis_cents: num(row.outstanding_cost_basis_cents),
      investment_count: num(row.investment_count),
    };
  });
}

export async function getPrivateInvestment(d: DB, assetId: string) {
  const [asset] = await rows<Record<string, unknown>>(
    d,
    sql`SELECT id, kind, name, notes, owner, stage, bear_pct, bull_pct, archived_at, created_at FROM private_investments WHERE id = ${assetId}`,
    ['id', 'kind', 'name', 'notes', 'owner', 'stage', 'bear_pct', 'bull_pct', 'archived_at', 'created_at'],
  );
  if (!asset) throw new Error(`Private investment not found: ${assetId}`);

  const { rounds: derivRounds, valuations: derivVals } = await fetchRoundsAndValuations(d, {
    assetId,
  });
  const now = Math.floor(Date.now() / 1000);
  const derived = deriveAssetValue(derivRounds, derivVals, now);

  const [basisRow] = await rows<{ funded: number; pending: number }>(
    d,
    sql`
      SELECT
        COALESCE(SUM(CASE WHEN funded_at IS NOT NULL THEN cost_basis_cents ELSE 0 END), 0) AS funded,
        COALESCE(SUM(CASE WHEN funded_at IS NULL THEN cost_basis_cents ELSE 0 END), 0) AS pending
      FROM investments WHERE asset_id = ${assetId} AND archived_at IS NULL
    `,
    ['funded', 'pending'],
  );
  const costBasisCents = num(basisRow?.funded);
  const outstandingCostBasisCents = num(basisRow?.pending);

  const invs = await rows<Record<string, unknown>>(
    d,
    sql`
      SELECT i.id, i.asset_id, i.security_type, i.round_label, i.shares, i.price_per_share_cents,
        i.cost_basis_cents, i.entry_date, i.funded_at, i.created_at
      FROM investments i
      WHERE i.asset_id = ${assetId} AND i.archived_at IS NULL
      ORDER BY i.entry_date DESC
    `,
    ['id', 'asset_id', 'security_type', 'round_label', 'shares', 'price_per_share_cents', 'cost_basis_cents', 'entry_date', 'funded_at', 'created_at'],
  );
  // Annotate each round with its derived current value (null when the asset
  // total comes from an asset-level override — the round doesn't have a
  // meaningful per-round value in that regime; or when the round is pending
  // and contributes no shares to the value derivation).
  const investments = invs.map((i) => ({
    ...i,
    derived_value_cents: derived.asset_level_override
      ? null
      : (derived.per_round.get(String(i.id)) ?? null),
  }));

  const vals = await rows<Record<string, unknown>>(
    d,
    sql`
      SELECT id, asset_id, investment_id, as_of, value_cents, basis, note, created_at
      FROM valuations WHERE asset_id = ${assetId} ORDER BY as_of DESC LIMIT 50
    `,
    ['id', 'asset_id', 'investment_id', 'as_of', 'value_cents', 'basis', 'note', 'created_at'],
  );

  const fd = await rows<Record<string, unknown>>(
    d,
    sql`
      SELECT asset_id, role, committed_cents, called_cents, distributed_cents, carry_pct, carry_vested_pct, created_at
      FROM fund_details WHERE asset_id = ${assetId}
    `,
    ['asset_id', 'role', 'committed_cents', 'called_cents', 'distributed_cents', 'carry_pct', 'carry_vested_pct', 'created_at'],
  );

  return {
    asset,
    investments,
    valuations: vals,
    fund_details: fd[0] ?? null,
    current_value_cents: derived.total_cents,
    cost_basis_cents: costBasisCents,
    outstanding_cost_basis_cents: outstandingCostBasisCents,
    asset_level_override: derived.asset_level_override,
  };
}

export type NetWorthPoint = {
  date: string;            // 'YYYY-MM-DD' in PT
  liquid_cents: number;
  private_cents: number;
  total_cents: number;
  synthetic?: boolean;     // true = backfilled baseline before first real snapshot
  fresh?: boolean;         // true = this day had at least one real snapshot/event;
                           // false = values are carry-forward from prior day (e.g.
                           // pre-sync window after midnight PT before the 3am cron)
};

const PT_DATE_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const ptDateKey = (sec: number): string => PT_DATE_FMT.format(new Date(sec * 1000));
const nextYmd = (ymd: string): string => shiftYmd(ymd, 1);

export async function netWorthSeries(d: DB, opts: { minDays?: number } = {}): Promise<NetWorthPoint[]> {
  const minDays = opts.minDays ?? 30;
  const snaps = await rows<{ account_id: string; balance_cents: number; is_liability: number; as_of: number }>(
    d,
    sql`
      SELECT bs.account_id, bs.balance_cents, a.is_liability, bs.as_of
      FROM balance_snapshots bs
      JOIN accounts a ON a.id = bs.account_id
      WHERE a.archived_at IS NULL
      ORDER BY bs.as_of ASC
    `,
    ['account_id', 'balance_cents', 'is_liability', 'as_of'],
  );
  const { rounds: allRounds, valuations: allVals } = await fetchRoundsAndValuations(d);

  if (snaps.length === 0 && allRounds.length === 0 && allVals.length === 0) return [];

  const acctByDate = new Map<string, Map<string, { balance: number; liability: boolean }>>();
  for (const s of snaps) {
    const day = ptDateKey(num(s.as_of));
    let m = acctByDate.get(day);
    if (!m) { m = new Map(); acctByDate.set(day, m); }
    m.set(s.account_id, { balance: num(s.balance_cents), liability: !!num(s.is_liability) });
  }

  const roundsByAsset = groupByAsset(allRounds);
  const valsByAsset = groupByAsset(allVals);
  const privateAssetIds = new Set([...roundsByAsset.keys(), ...valsByAsset.keys()]);

  // Days with at least one real event (snapshot, round entry, valuation mark).
  // Any other day's values are pure carry-forward from the prior day.
  const freshDays = new Set<string>();
  for (const s of snaps) freshDays.add(ptDateKey(num(s.as_of)));
  for (const r of allRounds) freshDays.add(ptDateKey(r.entry_date));
  for (const v of allVals) freshDays.add(ptDateKey(v.as_of));

  // End-of-day unix seconds for a YMD string — used as the `at_sec` for
  // derivation so same-day events (round entry, override mark) count toward
  // this day's total.
  const endOfDaySec = (ymd: string): number => {
    const [y, m, dd] = ymd.split('-').map(Number);
    return Math.floor(Date.UTC(y, m - 1, dd + 1) / 1000) - 1;
  };

  // Pick the earliest liquid snapshot or earliest private event to anchor the
  // series. Private events include round entry_dates and valuation as_ofs.
  const privateEventDays: string[] = [];
  for (const r of allRounds) privateEventDays.push(ptDateKey(r.entry_date));
  for (const v of allVals) privateEventDays.push(ptDateKey(v.as_of));
  const earliestPrivateDay = privateEventDays.length > 0
    ? privateEventDays.reduce((a, b) => (a < b ? a : b))
    : null;

  const start = snaps.length > 0
    ? ptDateKey(num(snaps[0].as_of))
    : earliestPrivateDay ?? ptDateKey(Math.floor(Date.now() / 1000));
  const today = ptDateKey(Math.floor(Date.now() / 1000));

  const acctState = new Map<string, { balance: number; liability: boolean }>();
  for (const s of snaps) {
    if (ptDateKey(num(s.as_of)) < start) {
      acctState.set(s.account_id, { balance: num(s.balance_cents), liability: !!num(s.is_liability) });
    }
  }

  const series: NetWorthPoint[] = [];

  let day = start;
  for (let i = 0; i < 1200 && day <= today; i++) {
    const au = acctByDate.get(day);
    if (au) for (const [k, v] of au) acctState.set(k, v);

    let liquid = 0;
    for (const v of acctState.values()) liquid += v.liability ? -v.balance : v.balance;

    const endSec = endOfDaySec(day);
    let priv = 0;
    for (const assetId of privateAssetIds) {
      const { total_cents } = deriveAssetValue(
        roundsByAsset.get(assetId) ?? [],
        valsByAsset.get(assetId) ?? [],
        endSec,
      );
      priv += total_cents;
    }

    series.push({
      date: day,
      liquid_cents: liquid,
      private_cents: priv,
      total_cents: liquid + priv,
      fresh: freshDays.has(day),
    });
    day = nextYmd(day);
  }

  // If we have less than `minDays` of real data, prepend a synthetic flat baseline
  // anchored to the first observed totals. Lets the chart render meaningfully
  // before the cron has accumulated history. Synthetic points are tagged so the
  // chart can render them differently (we don't want to pretend it's real).
  if (series.length > 0 && series.length < minDays) {
    const anchor = series[0];
    const padCount = minDays - series.length;
    const pad: NetWorthPoint[] = [];
    for (let k = padCount; k > 0; k--) {
      pad.push({
        date: shiftYmd(anchor.date, -k),
        liquid_cents: anchor.liquid_cents,
        private_cents: anchor.private_cents,
        total_cents: anchor.total_cents,
        synthetic: true,
      });
    }
    return [...pad, ...series];
  }
  return series;
}

export type AssetValuePoint = {
  as_of: number;
  date: string;
  value_cents: number;
  event: { kind: 'round' | 'mark'; label: string };
};

// Emit a point at every event that can move the derived value: each round's
// entry_date (new capital + mark-up of prior rounds from the new PPS) and
// each manual valuation's as_of (override point). At each event we re-derive
// the full asset value so the series reflects the current rule exactly.
export async function privateInvestmentValueSeries(d: DB, assetId: string): Promise<AssetValuePoint[]> {
  const { rounds, valuations } = await fetchRoundsAndValuations(d, { assetId });
  const timestamps = new Set<number>();
  for (const r of rounds) timestamps.add(r.entry_date);
  for (const v of valuations) timestamps.add(v.as_of);
  const sorted = [...timestamps].sort((a, b) => a - b);
  return sorted.map((t) => {
    const { total_cents } = deriveAssetValue(rounds, valuations, t);
    // Prefer round on timestamp collision — the round is the higher-signal event
    // (capital + PPS change) and any mark recorded on the same day is incidental.
    const round = rounds.find((r) => r.entry_date === t);
    const event: AssetValuePoint['event'] = round
      ? { kind: 'round', label: round.round_label ?? round.security_type ?? 'Round' }
      : (() => {
          const val = valuations.find((v) => v.as_of === t);
          return { kind: 'mark', label: val?.basis ?? 'Mark' };
        })();
    return { as_of: t, date: ptDateKey(t), value_cents: total_cents, event };
  });
}

export type SyncIssue = {
  item_id: string;
  institution: string;
  last_sync_at: number | null;
  last_error: string | null;
  status: string;
  stale: boolean;
};

// Cron runs daily at 10:00 UTC. A 30h threshold catches a missed run without
// false-alarming during the normal sync window.
const SYNC_STALE_SEC = 30 * 60 * 60;

export async function syncHealth(d: DB): Promise<SyncIssue[]> {
  const now = Math.floor(Date.now() / 1000);
  const all = await rows<{
    item_id: string;
    institution: string;
    last_sync_at: number | null;
    last_error: string | null;
    status: string;
  }>(
    d,
    sql`SELECT id AS item_id, institution_name AS institution, last_sync_at, last_error, status FROM plaid_items`,
    ['item_id', 'institution', 'last_sync_at', 'last_error', 'status'],
  );
  return all
    .map((r) => {
      const lastSync = r.last_sync_at == null ? null : num(r.last_sync_at);
      return {
        item_id: r.item_id,
        institution: r.institution,
        last_sync_at: lastSync,
        last_error: r.last_error,
        status: r.status,
        stale: lastSync == null || now - lastSync > SYNC_STALE_SEC,
      };
    })
    .filter((r) => r.last_error || r.status !== 'active' || r.stale);
}

export async function getAccount(d: DB, accountId: string) {
  const [account] = await rows<Record<string, unknown>>(
    d,
    sql`
      SELECT a.id, i.name AS institution, a.name, a.kind, a.currency, a.is_liability, a.source, a.owner, a.note,
        a.plaid_account_id, a.created_at, a.archived_at
      FROM accounts a JOIN institutions i ON i.id = a.institution_id
      WHERE a.id = ${accountId}
    `,
    ['id', 'institution', 'name', 'kind', 'currency', 'is_liability', 'source', 'owner', 'note', 'plaid_account_id', 'created_at', 'archived_at'],
  );
  if (!account) throw new Error(`Account not found: ${accountId}`);

  const snapshots = await rows<Record<string, unknown>>(
    d,
    sql`
      SELECT id, balance_cents, currency, as_of, source, created_at
      FROM balance_snapshots WHERE account_id = ${accountId} ORDER BY as_of DESC LIMIT 100
    `,
    ['id', 'balance_cents', 'currency', 'as_of', 'source', 'created_at'],
  );

  return { account, snapshots };
}
