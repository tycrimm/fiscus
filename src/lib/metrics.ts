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

  return {
    d1: delta(shiftYmd(today, -1)),
    w1: delta(shiftYmd(today, -7)),
    m1: delta(shiftYmd(today, -30)),
    ytd: delta(`${today.slice(0, 4)}-01-01`),
    y1: delta(shiftYmd(today, -365)),
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
