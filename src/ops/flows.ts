import { and, eq, isNull } from 'drizzle-orm';
import type { DB } from '../db';
import { expectedFlows } from '../db/schema';

export type Direction = 'inflow' | 'outflow';
export type Cadence = 'once' | 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'annual';
export type Owner = 'tyler' | 'julianne' | 'joint';

const nowSec = () => Math.floor(Date.now() / 1000);
const dateToSec = (iso: string) => Math.floor(new Date(iso + 'T12:00:00').getTime() / 1000);
const dollarsToCents = (d: number | undefined | null): number | null =>
  d == null ? null : Math.round(d * 100);

export async function addExpectedFlow(
  d: DB,
  input: {
    direction: Direction;
    label: string;
    cadence: Cadence;
    nextExpectedDate: string;            // ISO date "2026-12-31"
    amountExpectedDollars: number;
    amountLowDollars?: number;
    amountHighDollars?: number;
    accountId?: string;
    privateInvestmentId?: string;
    owner?: Owner;
    endsDate?: string;
    notes?: string;
  },
) {
  const [row] = await d
    .insert(expectedFlows)
    .values({
      direction: input.direction,
      label: input.label.trim(),
      cadence: input.cadence,
      nextExpectedAt: dateToSec(input.nextExpectedDate),
      amountExpectedCents: Math.round(input.amountExpectedDollars * 100),
      amountLowCents: dollarsToCents(input.amountLowDollars),
      amountHighCents: dollarsToCents(input.amountHighDollars),
      accountId: input.accountId ?? null,
      privateInvestmentId: input.privateInvestmentId ?? null,
      owner: input.owner ?? 'joint',
      endsAt: input.endsDate ? dateToSec(input.endsDate) : null,
      notes: input.notes ?? null,
    })
    .returning();
  if (!row) throw new Error('expected_flows insert failed');
  return row;
}

export async function listExpectedFlows(d: DB) {
  return await d
    .select()
    .from(expectedFlows)
    .where(isNull(expectedFlows.archivedAt));
}

export async function archiveExpectedFlow(d: DB, id: string) {
  await d
    .update(expectedFlows)
    .set({ archivedAt: nowSec() })
    .where(eq(expectedFlows.id, id));
  return { id, archived: true };
}

export async function updateExpectedFlow(
  d: DB,
  id: string,
  patch: {
    label?: string;
    cadence?: Cadence;
    nextExpectedDate?: string;
    amountExpectedDollars?: number;
    amountLowDollars?: number | null;
    amountHighDollars?: number | null;
    owner?: Owner;
    endsDate?: string | null;
    notes?: string | null;
    accountId?: string | null;
    privateInvestmentId?: string | null;
  },
) {
  const set: Record<string, unknown> = {};
  if (patch.label !== undefined) set.label = patch.label.trim();
  if (patch.cadence !== undefined) set.cadence = patch.cadence;
  if (patch.nextExpectedDate !== undefined) set.nextExpectedAt = dateToSec(patch.nextExpectedDate);
  if (patch.amountExpectedDollars !== undefined)
    set.amountExpectedCents = Math.round(patch.amountExpectedDollars * 100);
  if (patch.amountLowDollars !== undefined) set.amountLowCents = dollarsToCents(patch.amountLowDollars);
  if (patch.amountHighDollars !== undefined) set.amountHighCents = dollarsToCents(patch.amountHighDollars);
  if (patch.owner !== undefined) set.owner = patch.owner;
  if (patch.endsDate !== undefined) set.endsAt = patch.endsDate ? dateToSec(patch.endsDate) : null;
  if (patch.notes !== undefined) set.notes = patch.notes;
  if (patch.accountId !== undefined) set.accountId = patch.accountId;
  if (patch.privateInvestmentId !== undefined) set.privateInvestmentId = patch.privateInvestmentId;

  const [row] = await d
    .update(expectedFlows)
    .set(set)
    .where(and(eq(expectedFlows.id, id), isNull(expectedFlows.archivedAt)))
    .returning();
  if (!row) throw new Error(`expected_flows ${id} not found or archived`);
  return row;
}

// ─── forecast ───────────────────────────────────────────────────────────────

export type ProjectedFlow = {
  flowId: string;
  direction: Direction;
  label: string;
  owner: Owner;
  cadence: Cadence;
  date: number;                          // unix sec for this projected occurrence
  amountLowCents: number | null;
  amountExpectedCents: number;
  amountHighCents: number | null;
  accountId: string | null;
  privateInvestmentId: string | null;
};

function addCadence(date: number, cadence: Cadence): number {
  const d = new Date(date * 1000);
  switch (cadence) {
    case 'weekly':    d.setDate(d.getDate() + 7); break;
    case 'biweekly':  d.setDate(d.getDate() + 14); break;
    case 'monthly':   d.setMonth(d.getMonth() + 1); break;
    case 'quarterly': d.setMonth(d.getMonth() + 3); break;
    case 'annual':    d.setFullYear(d.getFullYear() + 1); break;
    case 'once':      return Number.POSITIVE_INFINITY;
  }
  return Math.floor(d.getTime() / 1000);
}

/**
 * Project active flows into individual occurrences within [now, now + windowDays].
 * One-off flows contribute at most one occurrence (and only if their date falls in window).
 * Recurring flows step forward from nextExpectedAt by their cadence.
 */
export async function forecastFlows(d: DB, windowDays = 30): Promise<ProjectedFlow[]> {
  const flows = await listExpectedFlows(d);
  const start = nowSec();
  const end = start + windowDays * 86400;

  const out: ProjectedFlow[] = [];
  for (const f of flows) {
    let cursor = f.nextExpectedAt;
    // Skip past occurrences (e.g. a weekly flow whose anchor was last month)
    while (cursor < start && f.cadence !== 'once') {
      cursor = addCadence(cursor, f.cadence);
      if (!Number.isFinite(cursor)) break;
    }
    while (Number.isFinite(cursor) && cursor <= end) {
      if (f.endsAt && cursor > f.endsAt) break;
      out.push({
        flowId: f.id,
        direction: f.direction,
        label: f.label,
        owner: f.owner,
        cadence: f.cadence,
        date: cursor,
        amountLowCents: f.amountLowCents,
        amountExpectedCents: f.amountExpectedCents,
        amountHighCents: f.amountHighCents,
        accountId: f.accountId,
        privateInvestmentId: f.privateInvestmentId,
      });
      if (f.cadence === 'once') break;
      cursor = addCadence(cursor, f.cadence);
    }
  }
  return out.sort((a, b) => a.date - b.date);
}
