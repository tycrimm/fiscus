import { eq } from 'drizzle-orm';
import type { DB } from '../db';
import { illiquidAssets, investments, valuations, fundDetails } from '../db/schema';

export type IlliquidKind =
  | 'private_company'
  | 'fund'
  | 'loan_receivable'
  | 'gift_earmark'
  | 'education_529'
  | 'other';

export type FundRole = 'lp' | 'gp' | 'both';

const toUnix = (v: number | string): number => {
  if (typeof v === 'number') return v;
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw new Error(`Invalid date: ${v}`);
  return Math.floor(t / 1000);
};

export async function addIlliquidAsset(
  d: DB,
  input: { kind: IlliquidKind; name: string; notes?: string },
) {
  const [row] = await d
    .insert(illiquidAssets)
    .values({
      kind: input.kind,
      name: input.name.trim(),
      notes: input.notes ?? null,
    })
    .returning();
  if (!row) throw new Error('Illiquid asset insert failed');
  return row;
}

export async function addInvestment(
  d: DB,
  input: {
    assetId: string;
    securityType?: string;
    roundLabel?: string;
    shares?: number;
    pricePerShareDollars?: number;
    costBasisDollars: number;
    entryDate: number | string;
  },
) {
  const entryDate = toUnix(input.entryDate);
  const costBasisCents = Math.round(input.costBasisDollars * 100);
  const [row] = await d
    .insert(investments)
    .values({
      assetId: input.assetId,
      securityType: input.securityType ?? null,
      roundLabel: input.roundLabel ?? null,
      shares: input.shares ?? null,
      pricePerShareCents:
        input.pricePerShareDollars != null ? Math.round(input.pricePerShareDollars * 100) : null,
      costBasisCents,
      entryDate,
    })
    .returning();
  if (!row) throw new Error('Investment insert failed');
  // An investment IS a valuation — cash changed hands at a known price on a known date.
  // Recording it here means time-series and net-worth reads work without UNION'ing both tables.
  await d.insert(valuations).values({
    assetId: input.assetId,
    investmentId: row.id,
    valueCents: costBasisCents,
    basis: 'Entry',
    note: null,
    asOf: entryDate,
  });
  return row;
}

export async function recordValuation(
  d: DB,
  input: {
    assetId: string;
    investmentId?: string;
    valueDollars: number;
    basis?: string;
    note?: string;
    asOf?: number | string;
  },
) {
  const asOf = input.asOf == null ? Math.floor(Date.now() / 1000) : toUnix(input.asOf);
  const [row] = await d
    .insert(valuations)
    .values({
      assetId: input.assetId,
      investmentId: input.investmentId ?? null,
      valueCents: Math.round(input.valueDollars * 100),
      basis: input.basis ?? null,
      note: input.note ?? null,
      asOf,
    })
    .returning();
  return row;
}

export async function setFundDetails(
  d: DB,
  input: {
    assetId: string;
    role: FundRole;
    committedDollars?: number;
    calledDollars?: number;
    distributedDollars?: number;
    carryPct?: number;
    carryVestedPct?: number;
  },
) {
  const values = {
    assetId: input.assetId,
    role: input.role,
    committedCents: input.committedDollars != null ? Math.round(input.committedDollars * 100) : 0,
    calledCents: input.calledDollars != null ? Math.round(input.calledDollars * 100) : 0,
    distributedCents:
      input.distributedDollars != null ? Math.round(input.distributedDollars * 100) : 0,
    carryPct: input.carryPct ?? null,
    carryVestedPct: input.carryVestedPct ?? null,
  };
  const [row] = await d
    .insert(fundDetails)
    .values(values)
    .onConflictDoUpdate({
      target: fundDetails.assetId,
      set: {
        role: values.role,
        committedCents: values.committedCents,
        calledCents: values.calledCents,
        distributedCents: values.distributedCents,
        carryPct: values.carryPct,
        carryVestedPct: values.carryVestedPct,
      },
    })
    .returning();
  return row;
}

export async function archiveIlliquidAsset(d: DB, assetId: string) {
  const now = Math.floor(Date.now() / 1000);
  await d.update(illiquidAssets).set({ archivedAt: now }).where(eq(illiquidAssets.id, assetId));
  return { assetId, archivedAt: now };
}
