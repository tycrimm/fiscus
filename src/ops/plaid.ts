import { eq } from 'drizzle-orm';
import type { DB } from '../db';
import { institutions, accounts, balanceSnapshots, plaidItems, plaidSyncLog } from '../db/schema';
import { encryptString, decryptString } from '../lib/crypto';
import { mapAccountKind, mapInstitutionKind, isLiabilityType, type PlaidEnv } from '../lib/plaid';

const nowSec = () => Math.floor(Date.now() / 1000);

// ─── Item lifecycle ─────────────────────────────────────────────────────────

export async function createPlaidItem(
  d: DB,
  env: PlaidEnv,
  args: {
    accessToken: string;
    plaidItemId: string;
    institutionPlaidId: string;
    institutionName: string;
    owner: 'tyler' | 'julianne' | 'joint';
  },
) {
  const encrypted = await encryptString(args.accessToken, env.PLAID_TOKEN_KEY);
  const [row] = await d
    .insert(plaidItems)
    .values({
      plaidItemId: args.plaidItemId,
      accessTokenEncrypted: encrypted,
      institutionPlaidId: args.institutionPlaidId,
      institutionName: args.institutionName,
      owner: args.owner,
      status: 'active',
    })
    .returning();
  if (!row) throw new Error('plaid_items insert failed');
  return row;
}

export async function listPlaidItems(d: DB) {
  return await d.select().from(plaidItems);
}

async function getDecryptedAccessToken(
  d: DB,
  env: PlaidEnv,
  itemId: string,
): Promise<{ accessToken: string; item: typeof plaidItems.$inferSelect }> {
  const [item] = await d.select().from(plaidItems).where(eq(plaidItems.id, itemId)).limit(1);
  if (!item) throw new Error(`plaid_items not found: ${itemId}`);
  const accessToken = await decryptString(item.accessTokenEncrypted, env.PLAID_TOKEN_KEY);
  return { accessToken, item };
}

// ─── Sync ───────────────────────────────────────────────────────────────────

/**
 * Pulls accounts + current balances for one Plaid item and projects them into
 * canonical tables (institutions, accounts, balance_snapshots). Idempotent —
 * looks up existing accounts by `plaid_account_id` and updates rather than
 * duplicating. Appends a new balance_snapshot per account every call.
 */
export async function syncItemAccountsAndBalances(d: DB, env: PlaidEnv, itemId: string) {
  const { accessToken, item } = await getDecryptedAccessToken(d, env, itemId);
  const plaid = (await import('../lib/plaid')).makePlaidClient(env);

  let raw: unknown;
  let ok = true;
  let errorMsg: string | null = null;
  try {
    const resp = await plaid.accountsBalanceGet({ access_token: accessToken });
    raw = resp.data;

    const inst = await findOrCreateInstitutionByPlaid(d, {
      plaidId: item.institutionPlaidId,
      name: item.institutionName,
      kind: mapInstitutionKind(resp.data.accounts.map((a) => a.type)),
    });

    let inserted = 0;
    let snapshots = 0;
    for (const a of resp.data.accounts) {
      const isLiab = isLiabilityType(a.type);
      const acct = await upsertAccount(d, {
        institutionId: inst.id,
        plaidAccountId: a.account_id,
        name: a.name,
        kind: mapAccountKind(a.type, a.subtype),
        currency: a.balances.iso_currency_code ?? 'USD',
        isLiability: isLiab,
        owner: item.owner,
      });
      if (acct.created) inserted++;

      // Plaid `current` is what we want for net worth; for credit accounts
      // it's the outstanding balance (which is_liability flips to negative).
      const balanceCents = Math.round((a.balances.current ?? 0) * 100);
      await d.insert(balanceSnapshots).values({
        accountId: acct.id,
        balanceCents,
        currency: a.balances.iso_currency_code ?? 'USD',
        asOf: nowSec(),
        source: 'plaid',
      });
      snapshots++;
    }

    await d
      .update(plaidItems)
      .set({ lastSyncAt: nowSec(), lastError: null, status: 'active' })
      .where(eq(plaidItems.id, itemId));

    return { itemId, accountsInserted: inserted, snapshotsWritten: snapshots };
  } catch (e) {
    ok = false;
    errorMsg = e instanceof Error ? e.message : String(e);
    raw = { error: errorMsg };
    await d
      .update(plaidItems)
      .set({ lastError: errorMsg, status: 'error' })
      .where(eq(plaidItems.id, itemId));
    throw e;
  } finally {
    await d.insert(plaidSyncLog).values({
      itemId,
      kind: 'accounts',
      ok,
      rawJson: JSON.stringify(raw),
      error: errorMsg,
    });
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

async function findOrCreateInstitutionByPlaid(
  d: DB,
  args: {
    plaidId: string;
    name: string;
    kind: 'bank' | 'brokerage' | 'credit_card' | 'retirement' | 'crypto' | 'other';
  },
) {
  const existing = await d
    .select()
    .from(institutions)
    .where(eq(institutions.plaidInstitutionId, args.plaidId))
    .limit(1);
  if (existing[0]) return existing[0];
  const [row] = await d
    .insert(institutions)
    .values({ name: args.name, kind: args.kind, plaidInstitutionId: args.plaidId })
    .returning();
  if (!row) throw new Error('institutions insert failed');
  return row;
}

type UpsertAccountResult = typeof accounts.$inferSelect & { created: boolean };

async function upsertAccount(
  d: DB,
  args: {
    institutionId: string;
    plaidAccountId: string;
    name: string;
    kind: 'checking' | 'savings' | 'brokerage' | 'credit_card' | 'retirement' | 'crypto' | 'loan' | 'other';
    currency: string;
    isLiability: boolean;
    owner: 'tyler' | 'julianne' | 'joint';
  },
): Promise<UpsertAccountResult> {
  const existing = await d
    .select()
    .from(accounts)
    .where(eq(accounts.plaidAccountId, args.plaidAccountId))
    .limit(1);
  if (existing[0]) {
    // Preserve archived_at AND owner — owner may have been manually adjusted
    // after link. Plaid item's owner only seeds new accounts.
    await d
      .update(accounts)
      .set({
        name: args.name,
        kind: args.kind,
        currency: args.currency,
        isLiability: args.isLiability,
      })
      .where(eq(accounts.id, existing[0].id));
    return { ...existing[0], created: false };
  }
  const [row] = await d
    .insert(accounts)
    .values({
      institutionId: args.institutionId,
      name: args.name,
      kind: args.kind,
      currency: args.currency,
      isLiability: args.isLiability,
      source: 'plaid',
      plaidAccountId: args.plaidAccountId,
      owner: args.owner,
    })
    .returning();
  if (!row) throw new Error('accounts insert failed');
  return { ...row, created: true };
}
