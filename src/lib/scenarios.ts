// Scenario ranges on private investments — see NEXT.md step 9.
//
// Each private_investment carries a `stage` that drives the default bear/bull
// multiplier on its current (expected) value. Per-asset overrides on
// `bear_pct` / `bull_pct` trump the default.
//
// Where stage is null, we fall back from `kind`: funds → fund bucket,
// private_company → growth (middle-of-road), everything else → other (tight).
//
// Multipliers are decimal fractions (0.7 = 70% of expected). Tune these as
// your worldview evolves — this file is the sole source of truth.

export type Stage = 'seed' | 'early' | 'growth' | 'late' | 'fund' | 'other';

export type Band = { bear_mult: number; bull_mult: number };

export const STAGE_BANDS: Record<Stage, Band> = {
  seed:   { bear_mult: 0.1, bull_mult: 10.0 },
  early:  { bear_mult: 0.3, bull_mult: 5.0 },
  growth: { bear_mult: 0.5, bull_mult: 3.0 },
  late:   { bear_mult: 0.6, bull_mult: 1.5 },
  fund:   { bear_mult: 0.7, bull_mult: 2.0 },
  other:  { bear_mult: 0.9, bull_mult: 1.1 },
};

export const STAGE_LABEL: Record<Stage, string> = {
  seed: 'Seed',
  early: 'Early (A/B)',
  growth: 'Growth (C/D)',
  late: 'Late / Pre-IPO',
  fund: 'Fund',
  other: 'Other',
};

export type StageInput = {
  kind: string;
  stage: Stage | null;
  bear_pct: number | null;
  bull_pct: number | null;
};

export function effectiveStage(input: StageInput): Stage {
  if (input.stage) return input.stage;
  if (input.kind === 'fund') return 'fund';
  if (input.kind === 'private_company') return 'growth';
  return 'other';
}

export function bandFor(input: StageInput): Band {
  const base = STAGE_BANDS[effectiveStage(input)];
  return {
    bear_mult: input.bear_pct ?? base.bear_mult,
    bull_mult: input.bull_pct ?? base.bull_mult,
  };
}

export function applyBand(valueCents: number, band: Band) {
  return {
    bear_cents: Math.round(valueCents * band.bear_mult),
    bull_cents: Math.round(valueCents * band.bull_mult),
  };
}

export function bandForValue(valueCents: number, input: StageInput) {
  return applyBand(valueCents, bandFor(input));
}
