import type { NetWorthPoint } from '../ops/reads';
import { shiftYmd } from './format';
import { CAPTURE_BASELINE_YMD } from './baseline';

// ─── change attribution (per-component deltas across windows) ──────────────
//
// For each window (1D, 1W, 1M, YTD, 1Y) and each balance-sheet component,
// compute current − prior in NAV-impact terms. So a $5K liability increase
// shows as −$5K (debt grew, NAV down); a fresh $14,824 uncalled allocation
// shows as −$14,824 (cash earmarked, NAV down). The net-worth row is the sum
// of the four bucket rows.

export type AttributionKey = 'liquid' | 'uncalled' | 'private' | 'liabilities' | 'nw';
export const ATTRIBUTION_LABEL: Record<AttributionKey, string> = {
  liquid: 'Liquid',
  uncalled: 'Uncalled',
  private: 'Private',
  liabilities: 'Liabilities',
  nw: 'Net worth',
};

export type WindowKey = 'd1' | 'w1' | 'm1' | 'ytd' | 'y1' | 'y5';
export const WINDOW_LABEL: Record<WindowKey, string> = {
  d1: '1D',
  w1: '1W',
  m1: '1M',
  ytd: 'YTD',
  y1: '1Y',
  y5: '5Y',
};

export type AttributionCell = {
  cents: number;       // NAV-impact contribution (signed)
  pct: number | null;  // delta / |prior basis|; null when prior basis was 0
} | null;              // null when window predates history

export type AttributionRow = Record<WindowKey, AttributionCell>;
export type ChangeAttribution = Record<AttributionKey, AttributionRow>;

// Compute the gross-liquid (positives only) value at a series point — i.e.
// liquid + liabilities, since liquid_cents is already net of liabilities.
const grossLiquid = (p: NetWorthPoint) => p.liquid_cents + p.liabilities_cents;

// NAV at a point = liquid + private − uncalled. Mirrors the displayed rail
// header: gross_assets − liabilities − uncalled.
const navAt = (p: NetWorthPoint) => p.liquid_cents + p.private_cents - p.uncalled_cents;

const componentValue = (p: NetWorthPoint, key: AttributionKey): number => {
  switch (key) {
    case 'liquid': return grossLiquid(p);
    case 'uncalled': return p.uncalled_cents;
    case 'private': return p.private_cents;
    case 'liabilities': return p.liabilities_cents;
    case 'nw': return navAt(p);
  }
};

// Sign of the NAV impact for a delta in this component's value:
//   +1 = increasing this value increases NAV (liquid, private, nw)
//   −1 = increasing this value decreases NAV (uncalled, liabilities)
const navImpactSign = (key: AttributionKey): 1 | -1 =>
  key === 'uncalled' || key === 'liabilities' ? -1 : 1;

export function computeChangeAttribution(series: NetWorthPoint[]): ChangeAttribution {
  const real = series.filter((p) => !p.synthetic);
  const empty: AttributionRow = { d1: null, w1: null, m1: null, ytd: null, y1: null, y5: null };
  if (real.length < 2) {
    return {
      liquid: empty, uncalled: empty, private: empty, liabilities: empty, nw: empty,
    };
  }

  const current = real[real.length - 1];
  const today = current.date;
  const firstRealDate = real[0].date;

  const findAtOrBefore = (target: string): NetWorthPoint | null => {
    if (target < firstRealDate) return null;
    for (let i = real.length - 1; i >= 0; i--) {
      if (real[i].date <= target) return real[i];
    }
    return null;
  };

  const targets: Record<WindowKey, string> = {
    d1:  shiftYmd(today, -1),
    w1:  shiftYmd(today, -7),
    m1:  shiftYmd(today, -30),
    ytd: `${today.slice(0, 4)}-01-01`,
    y1:  shiftYmd(today, -365),
    y5:  shiftYmd(today, -1825),
  };

  const cellFor = (key: AttributionKey, win: WindowKey): AttributionCell => {
    // Same 1D carry-forward suppression as computeDeltas — if today's values
    // are pure carry-forward, 1D would falsely read $0.
    if (win === 'd1' && current.fresh === false) return null;
    const prior = findAtOrBefore(targets[win]);
    if (!prior || prior.date === today) return null;
    // Anchor every row at the capture-baseline. Pre-baseline totals were
    // missing accounts (Schwab) so any cross-baseline delta — NW or component —
    // mostly reflects when imports landed, not real movement.
    if (prior.date < CAPTURE_BASELINE_YMD) return null;
    const sign = navImpactSign(key);
    const cur = componentValue(current, key);
    const prev = componentValue(prior, key);
    const cents = sign * (cur - prev);
    const basis = Math.abs(prev);
    const pct = basis > 0 ? (cur - prev) / basis : null;
    return { cents, pct };
  };

  const rowFor = (key: AttributionKey): AttributionRow => ({
    d1:  cellFor(key, 'd1'),
    w1:  cellFor(key, 'w1'),
    m1:  cellFor(key, 'm1'),
    ytd: cellFor(key, 'ytd'),
    y1:  cellFor(key, 'y1'),
    y5:  cellFor(key, 'y5'),
  });

  return {
    liquid:      rowFor('liquid'),
    uncalled:    rowFor('uncalled'),
    private:     rowFor('private'),
    liabilities: rowFor('liabilities'),
    nw:          rowFor('nw'),
  };
}

// ─── allocation mix (% of gross assets, excludes liabilities) ───────────────

type AllocAccount = {
  kind: string;
  is_liability: number;
  latest_cents: number | null;
};
type AllocPrivate = {
  kind: string;
  current_value_cents: number;
};

export type AllocationCategory = {
  key: 'cash' | 'equities' | 'crypto' | 'private' | 'other';
  label: string;
  cents: number;
  pct: number;
};

const CASH_KINDS = new Set(['checking', 'savings']);
const EQUITY_KINDS = new Set(['brokerage', 'retirement', 'education']);
const PRIVATE_KINDS = new Set(['private_company', 'fund']);

export const CLASS_LABEL: Record<AllocationCategory['key'], string> = {
  cash: 'Cash',
  equities: 'Equities & Funds',
  crypto: 'Crypto',
  private: 'Private',
  other: 'Other',
};

export function computeAllocation(
  accounts: AllocAccount[],
  privateInv: AllocPrivate[],
): { categories: AllocationCategory[]; totalCents: number } {
  let cash = 0;
  let equities = 0;
  let crypto = 0;
  let priv = 0;
  let other = 0;

  for (const a of accounts) {
    if (a.is_liability) continue;
    const c = a.latest_cents ?? 0;
    if (CASH_KINDS.has(a.kind)) cash += c;
    else if (EQUITY_KINDS.has(a.kind)) equities += c;
    else if (a.kind === 'crypto') crypto += c;
    else other += c;
  }
  for (const i of privateInv) {
    if (PRIVATE_KINDS.has(i.kind)) priv += i.current_value_cents;
    else other += i.current_value_cents;
  }

  const total = cash + equities + crypto + priv + other;
  const raw: Array<{ key: AllocationCategory['key']; label: string; cents: number }> = [
    { key: 'cash', label: 'Cash', cents: cash },
    { key: 'equities', label: 'Equities & Funds', cents: equities },
    { key: 'crypto', label: 'Crypto', cents: crypto },
    { key: 'private', label: 'Private', cents: priv },
    { key: 'other', label: 'Other', cents: other },
  ];

  const categories = raw
    .filter((r) => r.cents > 0)
    .map((r) => ({ ...r, pct: total > 0 ? r.cents / total : 0 }))
    .sort((a, b) => b.cents - a.cents);

  return { categories, totalCents: total };
}

// ─── top concentration (largest single positions, % of gross assets) ────────

type ConcAccount = {
  id: string;
  name: string;
  institution: string;
  kind: string;
  is_liability: number;
  latest_cents: number | null;
};
type ConcPrivate = {
  id: string;
  name: string;
  kind: string;
  current_value_cents: number;
};

export type PositionClass = AllocationCategory['key'];

export type Position = {
  id: string;
  label: string;
  sub: string;
  class: PositionClass;
  cents: number;
  pct: number;
  href?: string;
};

const classifyAccount = (kind: string): PositionClass => {
  if (CASH_KINDS.has(kind)) return 'cash';
  if (EQUITY_KINDS.has(kind)) return 'equities';
  if (kind === 'crypto') return 'crypto';
  return 'other';
};
const classifyPrivate = (kind: string): PositionClass =>
  PRIVATE_KINDS.has(kind) ? 'private' : 'other';

// Title-cased display for a private_investments.kind enum. The bucket-level
// chrome ("Private", "Crypto") already lives in CLASS_LABEL; this is the
// finer-grained detail rendered in cased typography (sub-column on
// /concentration). Falls back to a generic title-case for unknown values.
const PRIVATE_KIND_DETAIL: Record<string, string> = {
  private_company: 'Private Company',
  fund: 'Fund',
  loan_receivable: 'Loan',
  gift_earmark: 'Gift earmark',
  education_529: '529',
  other: 'Other',
};
const detailForPrivateKind = (kind: string): string =>
  PRIVATE_KIND_DETAIL[kind] ?? kind.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

export function allPositions(
  accounts: ConcAccount[],
  privateInv: ConcPrivate[],
  totalAssetsCents: number,
): Position[] {
  const positions: Array<Omit<Position, 'pct'>> = [];
  for (const a of accounts) {
    if (a.is_liability) continue;
    const cents = a.latest_cents ?? 0;
    if (cents <= 0) continue;
    positions.push({
      id: a.id,
      label: a.name,
      sub: a.institution,
      class: classifyAccount(a.kind),
      cents,
    });
  }
  for (const i of privateInv) {
    if (i.current_value_cents <= 0) continue;
    positions.push({
      id: i.id,
      label: i.name,
      sub: detailForPrivateKind(i.kind),
      class: classifyPrivate(i.kind),
      cents: i.current_value_cents,
      href: `/private-investments/${i.id}`,
    });
  }
  positions.sort((a, b) => b.cents - a.cents);
  return positions.map((p) => ({
    ...p,
    pct: totalAssetsCents > 0 ? p.cents / totalAssetsCents : 0,
  }));
}

export function topConcentration(
  accounts: ConcAccount[],
  privateInv: ConcPrivate[],
  totalAssetsCents: number,
  topN = 3,
): Position[] {
  return allPositions(accounts, privateInv, totalAssetsCents).slice(0, topN);
}

// ─── positions exploded by security (single-name concentration) ─────────────
//
// For investment accounts that have a holdings snapshot, replace the
// account-level row with: one row per security (aggregated across accounts
// when the same ticker is held in multiple brokerages) plus a "cash sleeve"
// row for the residual (account balance − sum of holdings). Investment
// accounts WITHOUT holdings data fall back to their account-level row so
// nothing disappears from the view. Non-investment accounts and private
// investments are unchanged.

type ConcHolding = {
  account_id: string;
  account_name: string;
  institution: string;
  security_id: string;
  ticker: string | null;
  security_name: string;
  security_kind: string;
  value_cents: number;
};

const SECURITY_TO_CLASS: Record<string, PositionClass> = {
  public: 'equities',
  fund: 'equities',
  crypto: 'crypto',
  private: 'private',
};

export function positionsBySecurity(
  accounts: ConcAccount[],
  privateInv: ConcPrivate[],
  holdings: ConcHolding[],
  totalAssetsCents: number,
): Position[] {
  // Aggregate holdings by ticker (or by security name if no ticker exists).
  // Plaid sometimes assigns different security_ids to the same ticker across
  // brokerages, so grouping by security_id alone would miss cross-account
  // concentration — the whole point of this view.
  type Bucket = {
    key: string;
    label: string;
    securityName: string;
    accounts: Set<string>;
    institutions: Set<string>;
    cents: number;
    kind: string;
  };
  const buckets = new Map<string, Bucket>();
  const heldByAccount = new Map<string, number>();
  for (const h of holdings) {
    if (h.value_cents <= 0) continue;
    heldByAccount.set(h.account_id, (heldByAccount.get(h.account_id) ?? 0) + h.value_cents);
    const key = h.ticker ?? `name:${h.security_name}`;
    let b = buckets.get(key);
    if (!b) {
      b = {
        key,
        label: h.ticker ?? h.security_name,
        securityName: h.security_name,
        accounts: new Set(),
        institutions: new Set(),
        cents: 0,
        kind: h.security_kind,
      };
      buckets.set(key, b);
    }
    b.cents += h.value_cents;
    b.accounts.add(h.account_id);
    b.institutions.add(h.institution);
  }

  const positions: Array<Omit<Position, 'pct'>> = [];

  for (const b of buckets.values()) {
    const subParts: string[] = [];
    if (b.label !== b.securityName) subParts.push(b.securityName);
    if (b.accounts.size > 1) {
      subParts.push(`${b.accounts.size} accounts`);
    } else if (b.institutions.size === 1) {
      subParts.push([...b.institutions][0]);
    }
    positions.push({
      id: `sec:${b.key}`,
      label: b.label,
      sub: subParts.join(' · '),
      class: SECURITY_TO_CLASS[b.kind] ?? 'equities',
      cents: b.cents,
    });
  }

  for (const a of accounts) {
    if (a.is_liability) continue;
    const cents = a.latest_cents ?? 0;
    if (cents <= 0) continue;
    const held = heldByAccount.get(a.id);
    if (held != null) {
      // Investment account with positions surfaced — only the cash sleeve
      // (residual after subtracting positions) remains at the account level.
      // Holdings/balance snapshots can be a few minutes apart so the residual
      // can be slightly negative; treat that as zero (don't emit a row).
      const residual = cents - held;
      if (residual > 0) {
        positions.push({
          id: `cash:${a.id}`,
          label: `${a.name} cash`,
          sub: a.institution,
          class: 'cash',
          cents: residual,
        });
      }
    } else {
      positions.push({
        id: a.id,
        label: a.name,
        sub: a.institution,
        class: classifyAccount(a.kind),
        cents,
      });
    }
  }

  for (const i of privateInv) {
    if (i.current_value_cents <= 0) continue;
    positions.push({
      id: i.id,
      label: i.name,
      sub: detailForPrivateKind(i.kind),
      class: classifyPrivate(i.kind),
      cents: i.current_value_cents,
      href: `/private-investments/${i.id}`,
    });
  }

  positions.sort((a, b) => b.cents - a.cents);
  return positions.map((p) => ({
    ...p,
    pct: totalAssetsCents > 0 ? p.cents / totalAssetsCents : 0,
  }));
}

export type ConcentrationStats = {
  top1: number;   // share of gross assets held by the #1 position, 0-1
  top5: number;
  top10: number;
  hhi: number;    // Herfindahl index, sum of squared shares, 0-1 (1 = one position)
};

export function concentrationStats(positions: Position[]): ConcentrationStats {
  const sorted = [...positions].sort((a, b) => b.pct - a.pct);
  const sumPct = (n: number) => sorted.slice(0, n).reduce((s, p) => s + p.pct, 0);
  const hhi = sorted.reduce((s, p) => s + p.pct * p.pct, 0);
  return { top1: sumPct(1), top5: sumPct(5), top10: sumPct(10), hhi };
}
