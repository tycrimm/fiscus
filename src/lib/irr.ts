// Internal rate of return for a stream of dated cashflows.
//
// By convention: money out (contributions) is negative, money in (distributions
// or terminal value) is positive. Dates are unix seconds. Terminal value should
// be dated "today" so a stale mark naturally decays the annualized rate as time
// passes without a fresh valuation — standard PE/VC display.
//
// Returns the annualized rate (e.g. 0.235 = 23.5%). Returns null when the
// cashflows can't yield an IRR: no sign change, empty, or no bracket found.

export type Cashflow = { t_sec: number; amount_cents: number };

const SECONDS_PER_YEAR = 365.25 * 86400;

export function irr(cashflows: Cashflow[]): number | null {
  if (cashflows.length < 2) return null;
  const hasNeg = cashflows.some((c) => c.amount_cents < 0);
  const hasPos = cashflows.some((c) => c.amount_cents > 0);
  if (!hasNeg || !hasPos) return null;

  const t0 = Math.min(...cashflows.map((c) => c.t_sec));
  const flows = cashflows.map((c) => ({
    t: (c.t_sec - t0) / SECONDS_PER_YEAR,
    a: c.amount_cents,
  }));

  const npv = (r: number): number => {
    let sum = 0;
    for (const f of flows) sum += f.a / Math.pow(1 + r, f.t);
    return sum;
  };

  let lo = -0.9999;
  let hi = 100;
  let fLo = npv(lo);
  let fHi = npv(hi);
  if (!isFinite(fLo) || !isFinite(fHi) || fLo * fHi > 0) return null;

  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const fMid = npv(mid);
    if (!isFinite(fMid)) return null;
    if (Math.abs(fMid) < 0.5 || hi - lo < 1e-7) return mid;
    if (fMid * fLo < 0) { hi = mid; fHi = fMid; }
    else { lo = mid; fLo = fMid; }
  }
  return (lo + hi) / 2;
}
