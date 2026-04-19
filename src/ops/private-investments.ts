import { and, eq, isNull, lt, ne } from 'drizzle-orm';
import type { DB } from '../db';
import { privateInvestments, investments, valuations, fundDetails } from '../db/schema';

export type PrivateInvestmentKind =
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

export async function addPrivateInvestment(
  d: DB,
  input: { kind: PrivateInvestmentKind; name: string; notes?: string; owner?: 'tyler' | 'julianne' | 'joint' },
) {
  const [row] = await d
    .insert(privateInvestments)
    .values({
      kind: input.kind,
      name: input.name.trim(),
      notes: input.notes ?? null,
      owner: input.owner ?? 'joint',
    })
    .returning();
  if (!row) throw new Error('Private investment insert failed');
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
    qsbsEligible?: boolean;
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
      qsbsEligible: input.qsbsEligible ?? null,
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
  // Mark earlier priced rounds to this one's PPS. A new priced round on a private company
  // resets FMV for every prior check of the same asset — standard VC mark-to-last-round.
  // Only back-dated writes on private_company kind; funds/loans/gifts don't have fungible shares.
  if (row.pricePerShareCents != null) {
    const [asset] = await d
      .select({ kind: privateInvestments.kind })
      .from(privateInvestments)
      .where(eq(privateInvestments.id, input.assetId));
    if (asset?.kind === 'private_company') {
      const priorRounds = await d
        .select({ id: investments.id, shares: investments.shares })
        .from(investments)
        .where(
          and(
            eq(investments.assetId, input.assetId),
            ne(investments.id, row.id),
            isNull(investments.archivedAt),
            lt(investments.entryDate, entryDate),
          ),
        );
      const marks = priorRounds
        .filter((r): r is { id: string; shares: number } => r.shares != null && r.shares > 0)
        .map((r) => ({
          assetId: input.assetId,
          investmentId: r.id,
          valueCents: r.shares * row.pricePerShareCents!,
          basis: 'Last round',
          note: `Marked to ${row.roundLabel ?? 'new round'} PPS`,
          asOf: entryDate,
        }));
      if (marks.length > 0) await d.insert(valuations).values(marks);
    }
  }
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

export async function updateInvestment(
  d: DB,
  id: string,
  patch: {
    securityType?: string | null;
    roundLabel?: string | null;
    shares?: number | null;
    pricePerShareDollars?: number | null;
    costBasisDollars?: number;
    entryDate?: number | string;
    qsbsEligible?: boolean | null;
  },
) {
  const set: Record<string, unknown> = {};
  if ('securityType' in patch) set.securityType = patch.securityType;
  if ('roundLabel' in patch) set.roundLabel = patch.roundLabel;
  if ('shares' in patch) set.shares = patch.shares;
  if ('pricePerShareDollars' in patch) {
    set.pricePerShareCents =
      patch.pricePerShareDollars == null ? null : Math.round(patch.pricePerShareDollars * 100);
  }
  if (patch.costBasisDollars != null) set.costBasisCents = Math.round(patch.costBasisDollars * 100);
  if (patch.entryDate != null) set.entryDate = toUnix(patch.entryDate);
  if ('qsbsEligible' in patch) set.qsbsEligible = patch.qsbsEligible;
  if (Object.keys(set).length === 0) throw new Error('updateInvestment: no fields to update');
  const [row] = await d.update(investments).set(set).where(eq(investments.id, id)).returning();
  if (!row) throw new Error(`Investment not found: ${id}`);
  return row;
}

export async function updateValuation(
  d: DB,
  id: string,
  patch: {
    valueDollars?: number;
    basis?: string | null;
    note?: string | null;
    asOf?: number | string;
    investmentId?: string | null;
  },
) {
  const set: Record<string, unknown> = {};
  if (patch.valueDollars != null) set.valueCents = Math.round(patch.valueDollars * 100);
  if ('basis' in patch) set.basis = patch.basis;
  if ('note' in patch) set.note = patch.note;
  if (patch.asOf != null) set.asOf = toUnix(patch.asOf);
  if ('investmentId' in patch) set.investmentId = patch.investmentId;
  if (Object.keys(set).length === 0) throw new Error('updateValuation: no fields to update');
  const [row] = await d.update(valuations).set(set).where(eq(valuations.id, id)).returning();
  if (!row) throw new Error(`Valuation not found: ${id}`);
  return row;
}

export async function archivePrivateInvestment(d: DB, assetId: string) {
  const now = Math.floor(Date.now() / 1000);
  await d.update(privateInvestments).set({ archivedAt: now }).where(eq(privateInvestments.id, assetId));
  return { assetId, archivedAt: now };
}
