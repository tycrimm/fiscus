import { eq, sql } from 'drizzle-orm';
import type { DB } from '../db';
import { accounts, balanceSnapshots, institutions } from '../db/schema';

export type InstitutionKind = 'bank' | 'brokerage' | 'credit_card' | 'retirement' | 'crypto' | 'other';
export type AccountKind = 'checking' | 'savings' | 'brokerage' | 'credit_card' | 'retirement' | 'crypto' | 'loan' | 'other';

export async function findOrCreateInstitution(d: DB, name: string, kind: InstitutionKind = 'other') {
  const normalized = name.trim();
  const existing = await d
    .select()
    .from(institutions)
    .where(sql`lower(${institutions.name}) = lower(${normalized})`)
    .limit(1);
  if (existing[0]) return existing[0];
  const [row] = await d.insert(institutions).values({ name: normalized, kind }).returning();
  if (!row) throw new Error('Institution insert failed');
  return row;
}

export async function addAccount(
  d: DB,
  input: {
    institutionName: string;
    institutionKind?: InstitutionKind;
    accountName: string;
    accountKind?: AccountKind;
    isLiability?: boolean;
    balanceDollars: number;
  },
) {
  const inst = await findOrCreateInstitution(d, input.institutionName, input.institutionKind ?? 'other');
  const [acct] = await d
    .insert(accounts)
    .values({
      institutionId: inst.id,
      name: input.accountName.trim(),
      kind: input.accountKind ?? 'other',
      isLiability: input.isLiability ?? false,
    })
    .returning();
  if (!acct) throw new Error('Account insert failed');
  await d.insert(balanceSnapshots).values({
    accountId: acct.id,
    balanceCents: Math.round(input.balanceDollars * 100),
    asOf: Math.floor(Date.now() / 1000),
  });
  return acct;
}

export async function recordBalance(d: DB, accountId: string, balanceDollars: number) {
  const [acct] = await d.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
  if (!acct) throw new Error(`Account ${accountId} not found`);
  const [snap] = await d
    .insert(balanceSnapshots)
    .values({
      accountId,
      balanceCents: Math.round(balanceDollars * 100),
      asOf: Math.floor(Date.now() / 1000),
    })
    .returning();
  return snap;
}
