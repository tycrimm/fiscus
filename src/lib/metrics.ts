import type { NetWorthPoint } from '../ops/reads';

// ─── net worth deltas over standard windows ─────────────────────────────────

export type Delta = { cents: number; pct: number } | null;

export type NetWorthDeltas = {
  d1: Delta;
  w1: Delta;
  m1: Delta;
  ytd: Delta;
  y1: Delta;
};

const shiftYmd = (ymd: string, deltaDays: number): string => {
  const [y, m, d] = ymd.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d) + deltaDays * 86400000);
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`;
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
type AllocIlliquid = {
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
const PRIVATE_ILLIQ_KINDS = new Set(['private_company', 'fund']);

export function computeAllocation(
  accounts: AllocAccount[],
  illiquid: AllocIlliquid[],
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
  for (const i of illiquid) {
    if (PRIVATE_ILLIQ_KINDS.has(i.kind)) priv += i.current_value_cents;
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
type ConcIlliquid = {
  id: string;
  name: string;
  kind: string;
  current_value_cents: number;
};

export type Position = {
  id: string;
  label: string;
  sub: string;
  cents: number;
  pct: number;
};

export function topConcentration(
  accounts: ConcAccount[],
  illiquid: ConcIlliquid[],
  totalAssetsCents: number,
  topN = 3,
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
      cents,
    });
  }
  for (const i of illiquid) {
    if (i.current_value_cents <= 0) continue;
    positions.push({
      id: i.id,
      label: i.name,
      sub: i.kind,
      cents: i.current_value_cents,
    });
  }
  positions.sort((a, b) => b.cents - a.cents);
  return positions.slice(0, topN).map((p) => ({
    ...p,
    pct: totalAssetsCents > 0 ? p.cents / totalAssetsCents : 0,
  }));
}
