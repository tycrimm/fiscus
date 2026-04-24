import type { NetWorthPoint } from '../ops/reads';
import { shiftYmd } from './format';

// ─── net worth deltas over standard windows ─────────────────────────────────

export type Delta = { cents: number; pct: number } | null;

export type NetWorthDeltas = {
  d1: Delta;
  w1: Delta;
  m1: Delta;
  ytd: Delta;
  y1: Delta;
};

export function computeDeltas(series: NetWorthPoint[]): NetWorthDeltas {
  const empty: NetWorthDeltas = { d1: null, w1: null, m1: null, ytd: null, y1: null };
  const real = series.filter((p) => !p.synthetic);
  if (real.length < 2) return empty;

  const current = real[real.length - 1];
  const today = current.date;
  const firstRealDate = real[0].date;

  // Latest real point with date <= target. Returns null if target predates history.
  const findAtOrBefore = (target: string): NetWorthPoint | null => {
    if (target < firstRealDate) return null;
    for (let i = real.length - 1; i >= 0; i--) {
      if (real[i].date <= target) return real[i];
    }
    return null;
  };

  const delta = (target: string): Delta => {
    const p = findAtOrBefore(target);
    if (!p || p.date === today) return null;
    const c = current.total_cents - p.total_cents;
    const pct = p.total_cents !== 0 ? c / p.total_cents : 0;
    return { cents: c, pct };
  };

  // 1D is the only window sensitive to today being carry-forward: if today
  // hasn't synced yet, current == yesterday's values exactly, so 1D would
  // read $0. Hide it rather than mislead. Longer windows are fine — a one-
  // day slip at the right edge doesn't meaningfully distort them.
  return {
    d1: current.fresh === false ? null : delta(shiftYmd(today, -1)),
    w1: delta(shiftYmd(today, -7)),
    m1: delta(shiftYmd(today, -30)),
    ytd: delta(`${today.slice(0, 4)}-01-01`),
    y1: delta(shiftYmd(today, -365)),
  };
}

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

export type WindowKey = 'd1' | 'w1' | 'm1' | 'ytd' | 'y1';
export const WINDOW_LABEL: Record<WindowKey, string> = {
  d1: '1D',
  w1: '1W',
  m1: '1M',
  ytd: 'YTD',
  y1: '1Y',
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
  const empty: AttributionRow = { d1: null, w1: null, m1: null, ytd: null, y1: null };
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
  };

  const cellFor = (key: AttributionKey, win: WindowKey): AttributionCell => {
    // Same 1D carry-forward suppression as computeDeltas — if today's values
    // are pure carry-forward, 1D would falsely read $0.
    if (win === 'd1' && current.fresh === false) return null;
    const prior = findAtOrBefore(targets[win]);
    if (!prior || prior.date === today) return null;
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
      sub: `${a.institution} · ${a.kind}`,
      class: classifyAccount(a.kind),
      cents,
    });
  }
  for (const i of privateInv) {
    if (i.current_value_cents <= 0) continue;
    positions.push({
      id: i.id,
      label: i.name,
      sub: i.kind,
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
