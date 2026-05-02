// The day account capture became complete (Schwab was the last holdout).
// Net-worth deltas computed across this boundary are misleading — pre-baseline
// totals are missing accounts and read low. The net-worth series is floored
// here so the homepage chart and change-attribution windows only consider
// snapshots from this point forward.
//
// Per-account history (e.g. AccountBalanceChart) is *not* clipped — that data
// is still accurate per-account, just not summable into a meaningful NW total.
export const CAPTURE_BASELINE_YMD = '2026-05-02';
