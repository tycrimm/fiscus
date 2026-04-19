import { sql, type SQL } from 'drizzle-orm';
import type { DB } from '../db';

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

  const [privRow] = await rows<{ cents: number }>(
    d,
    sql`
      WITH ranked AS (
        SELECT v.value_cents,
          ROW_NUMBER() OVER (
            PARTITION BY v.asset_id, COALESCE(v.investment_id, '__asset_level__')
            ORDER BY v.as_of DESC
          ) AS rn
        FROM valuations v
        JOIN private_investments pi ON pi.id = v.asset_id
        WHERE pi.archived_at IS NULL
      )
      SELECT COALESCE(SUM(value_cents), 0) AS cents FROM ranked WHERE rn = 1
    `,
    ['cents'],
  );
  const privateCents = num(privRow?.cents);

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
  current_value_cents: number;
  total_cost_basis_cents: number;
  investment_count: number;
};

export async function listPrivateInvestments(d: DB): Promise<PrivateInvestmentRow[]> {
  return rows<PrivateInvestmentRow>(
    d,
    sql`
      WITH latest_per_leaf AS (
        SELECT v.asset_id, v.value_cents,
          ROW_NUMBER() OVER (
            PARTITION BY v.asset_id, COALESCE(v.investment_id, '__asset_level__')
            ORDER BY v.as_of DESC
          ) AS rn
        FROM valuations v
      )
      SELECT pi.id, pi.kind, pi.name, pi.notes, pi.owner,
        (SELECT COALESCE(SUM(value_cents), 0) FROM latest_per_leaf WHERE asset_id = pi.id AND rn = 1) AS current_value_cents,
        (SELECT COALESCE(SUM(cost_basis_cents), 0) FROM investments WHERE asset_id = pi.id AND archived_at IS NULL) AS total_cost_basis_cents,
        (SELECT COUNT(*) FROM investments WHERE asset_id = pi.id AND archived_at IS NULL) AS investment_count
      FROM private_investments pi
      WHERE pi.archived_at IS NULL
      ORDER BY pi.kind, pi.name
    `,
    ['id', 'kind', 'name', 'notes', 'owner', 'current_value_cents', 'total_cost_basis_cents', 'investment_count'],
  );
}

export async function getPrivateInvestment(d: DB, assetId: string) {
  const [asset] = await rows<Record<string, unknown>>(
    d,
    sql`SELECT id, kind, name, notes, owner, archived_at, created_at FROM private_investments WHERE id = ${assetId}`,
    ['id', 'kind', 'name', 'notes', 'owner', 'archived_at', 'created_at'],
  );
  if (!asset) throw new Error(`Private investment not found: ${assetId}`);

  // Latest-per-leaf summed — same semantic as listPrivateInvestments and netWorth.
  // Partitions on investment_id with a sentinel so asset-level marks also count.
  const [valRow] = await rows<{ cents: number }>(
    d,
    sql`
      WITH latest_per_leaf AS (
        SELECT v.value_cents,
          ROW_NUMBER() OVER (
            PARTITION BY COALESCE(v.investment_id, '__asset_level__')
            ORDER BY v.as_of DESC
          ) AS rn
        FROM valuations v
        WHERE v.asset_id = ${assetId}
      )
      SELECT COALESCE(SUM(value_cents), 0) AS cents FROM latest_per_leaf WHERE rn = 1
    `,
    ['cents'],
  );
  const currentValueCents = num(valRow?.cents);

  const [basisRow] = await rows<{ cents: number }>(
    d,
    sql`
      SELECT COALESCE(SUM(cost_basis_cents), 0) AS cents
      FROM investments WHERE asset_id = ${assetId} AND archived_at IS NULL
    `,
    ['cents'],
  );
  const costBasisCents = num(basisRow?.cents);

  const invs = await rows<Record<string, unknown>>(
    d,
    sql`
      SELECT i.id, i.asset_id, i.security_type, i.round_label, i.shares, i.price_per_share_cents,
        i.cost_basis_cents, i.entry_date, i.created_at,
        (SELECT value_cents FROM valuations WHERE investment_id = i.id ORDER BY as_of DESC LIMIT 1) AS latest_value_cents,
        (SELECT as_of        FROM valuations WHERE investment_id = i.id ORDER BY as_of DESC LIMIT 1) AS latest_as_of
      FROM investments i
      WHERE i.asset_id = ${assetId} AND i.archived_at IS NULL
      ORDER BY i.entry_date DESC
    `,
    ['id', 'asset_id', 'security_type', 'round_label', 'shares', 'price_per_share_cents', 'cost_basis_cents', 'entry_date', 'created_at', 'latest_value_cents', 'latest_as_of'],
  );

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
    investments: invs,
    valuations: vals,
    fund_details: fd[0] ?? null,
    current_value_cents: currentValueCents,
    cost_basis_cents: costBasisCents,
  };
}

export type NetWorthPoint = {
  date: string;            // 'YYYY-MM-DD' in PT
  liquid_cents: number;
  private_cents: number;
  total_cents: number;
  synthetic?: boolean;     // true = backfilled baseline before first real snapshot
};

const PT_DATE_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const ptDateKey = (sec: number): string => PT_DATE_FMT.format(new Date(sec * 1000));
const shiftYmd = (ymd: string, deltaDays: number): string => {
  const [y, m, d] = ymd.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d) + deltaDays * 86400000);
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`;
};
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
  const vals = await rows<{ asset_id: string; investment_id: string | null; value_cents: number; as_of: number }>(
    d,
    sql`
      SELECT v.asset_id, v.investment_id, v.value_cents, v.as_of
      FROM valuations v
      JOIN private_investments pi ON pi.id = v.asset_id
      WHERE pi.archived_at IS NULL
      ORDER BY v.as_of ASC
    `,
    ['asset_id', 'investment_id', 'value_cents', 'as_of'],
  );

  if (snaps.length === 0 && vals.length === 0) return [];

  // Bucket per-day per-leaf: only the latest entry per (leaf, day) survives.
  const acctByDate = new Map<string, Map<string, { balance: number; liability: boolean }>>();
  for (const s of snaps) {
    const day = ptDateKey(num(s.as_of));
    let m = acctByDate.get(day);
    if (!m) { m = new Map(); acctByDate.set(day, m); }
    m.set(s.account_id, { balance: num(s.balance_cents), liability: !!num(s.is_liability) });
  }
  const valByDate = new Map<string, Map<string, number>>();
  for (const v of vals) {
    const day = ptDateKey(num(v.as_of));
    const leaf = `${v.asset_id}::${v.investment_id ?? '__asset__'}`;
    let m = valByDate.get(day);
    if (!m) { m = new Map(); valByDate.set(day, m); }
    m.set(leaf, num(v.value_cents));
  }

  // Anchor to earliest *liquid* snapshot — private valuations carry historical
  // entry_dates (years back), but those pre-snapshot days have liquid=0 and
  // paint a misleading picture. Pre-warm private state with older valuations
  // so the earliest rendered day still reflects them. Fall back to earliest
  // valuation if there are no liquid snapshots at all.
  const start = snaps.length > 0
    ? ptDateKey(num(snaps[0].as_of))
    : [...valByDate.keys()].sort()[0]!;
  const today = ptDateKey(Math.floor(Date.now() / 1000));

  const acctState = new Map<string, { balance: number; liability: boolean }>();
  const valState = new Map<string, number>();

  // Pre-warm: apply any observations strictly before `start` so carry-forward
  // state is correct on day 0. snaps/vals are already sorted ASC by as_of, so
  // later observations correctly overwrite earlier ones in the Maps.
  for (const s of snaps) {
    if (ptDateKey(num(s.as_of)) < start) {
      acctState.set(s.account_id, { balance: num(s.balance_cents), liability: !!num(s.is_liability) });
    }
  }
  for (const v of vals) {
    if (ptDateKey(num(v.as_of)) < start) {
      const leaf = `${v.asset_id}::${v.investment_id ?? '__asset__'}`;
      valState.set(leaf, num(v.value_cents));
    }
  }

  const series: NetWorthPoint[] = [];

  let day = start;
  // Hard cap to defend against pathological data; ~3y of daily points is plenty.
  for (let i = 0; i < 1200 && day <= today; i++) {
    const au = acctByDate.get(day);
    if (au) for (const [k, v] of au) acctState.set(k, v);
    const vu = valByDate.get(day);
    if (vu) for (const [k, v] of vu) valState.set(k, v);

    let liquid = 0;
    for (const v of acctState.values()) liquid += v.liability ? -v.balance : v.balance;
    let priv = 0;
    for (const v of valState.values()) priv += v;

    series.push({ date: day, liquid_cents: liquid, private_cents: priv, total_cents: liquid + priv });
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

export type AssetValuePoint = { as_of: number; date: string; value_cents: number };

// One cumulative value per distinct as_of: replay valuations in order, keep the latest
// per (asset-level vs investment_id) leaf, sum. Unlike netWorthSeries this doesn't
// expand to daily points — the chart step-interpolates between events.
export async function privateInvestmentValueSeries(d: DB, assetId: string): Promise<AssetValuePoint[]> {
  const events = await rows<{ investment_id: string | null; value_cents: number; as_of: number }>(
    d,
    sql`
      SELECT v.investment_id, v.value_cents, v.as_of
      FROM valuations v
      WHERE v.asset_id = ${assetId}
      ORDER BY v.as_of ASC, v.created_at ASC
    `,
    ['investment_id', 'value_cents', 'as_of'],
  );
  const byLeaf = new Map<string, number>();
  const byAsOf = new Map<number, number>();
  for (const e of events) {
    const leaf = e.investment_id ?? '__asset__';
    byLeaf.set(leaf, num(e.value_cents));
    let total = 0;
    for (const v of byLeaf.values()) total += v;
    byAsOf.set(num(e.as_of), total);
  }
  return [...byAsOf.entries()]
    .sort(([a], [b]) => a - b)
    .map(([as_of, value_cents]) => ({ as_of, date: ptDateKey(as_of), value_cents }));
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
