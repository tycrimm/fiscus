// Shared viewBox geometry for line charts. Callers compute paths/points in
// this coordinate space; <Chart> renders with the same dimensions.
export const CHART_W = 1000;
export const CHART_H = 220;
export const CHART_PAD_T = 8;
export const CHART_PAD_B = 22;
export const CHART_INNER_H = CHART_H - CHART_PAD_T - CHART_PAD_B;

// y-scale shared between PrivateInvestmentChart and the scenario panel so
// the panel's rows can align vertically with the ghost-line endpoints.
// When bear/bull multipliers are provided, the scale expands to include
// current × mult so neither ghost clips.
export function computeYScale(opts: {
  values: number[];
  currentValueCents?: number;
  bearMult?: number | null;
  bullMult?: number | null;
}) {
  const { values, currentValueCents = 0, bearMult, bullMult } = opts;
  const showBand = bearMult != null && bullMult != null;
  const lo = values.length ? Math.min(...values) : 0;
  const hi = values.length ? Math.max(...values) : 0;
  const effectiveLo = showBand ? Math.min(lo, currentValueCents * bearMult) : lo;
  const effectiveHi = showBand ? Math.max(hi, currentValueCents * bullMult) : hi;
  const span = Math.max(effectiveHi - effectiveLo, 1);
  const yMin = Math.max(0, effectiveLo - span * 0.1);
  const yMax = effectiveHi + span * 0.1;
  const yRange = yMax - yMin || 1;
  const yAt = (cents: number) => CHART_PAD_T + (1 - (cents - yMin) / yRange) * CHART_INNER_H;
  return { yMin, yMax, yAt };
}
