// Shared viewBox geometry for line charts. Callers compute paths/points in
// this coordinate space; <Chart> renders with the same dimensions.
export const CHART_W = 1000;
export const CHART_H = 220;
export const CHART_PAD_T = 8;
export const CHART_PAD_B = 22;
export const CHART_INNER_H = CHART_H - CHART_PAD_T - CHART_PAD_B;
