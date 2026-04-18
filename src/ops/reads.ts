import { sql, type SQL } from 'drizzle-orm';
import type { DB } from '../db';

// Drizzle's sqlite-proxy returns positional arrays for raw sql`...`.
// This helper maps them to objects via an explicit column list.
async function rows<T>(d: DB, query: SQL, cols: readonly string[]): Promise<T[]> {
  const raw = (await d.all(query)) as unknown[][];
  return raw.map((r) => {
    const o: Record<string, unknown> = {};
    cols.forEach((c, i) => (o[c] = r[i]));
    return o as T;
  });
}

const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v ?? 0));

export async function netWorth(d: DB) {
  const liq = (await d.all(sql`
    SELECT COALESCE(SUM(CASE WHEN a.is_liability THEN -bs.balance_cents ELSE bs.balance_cents END), 0) AS cents
    FROM accounts a
    JOIN balance_snapshots bs ON bs.id = (
      SELECT id FROM balance_snapshots WHERE account_id = a.id ORDER BY as_of DESC LIMIT 1
    )
    WHERE a.archived_at IS NULL
  `)) as unknown[][];
  const liquidCents = num(liq[0]?.[0]);

  const ill = (await d.all(sql`
    WITH ranked AS (
      SELECT v.value_cents,
        ROW_NUMBER() OVER (
          PARTITION BY v.asset_id, COALESCE(v.investment_id, '__asset_level__')
          ORDER BY v.as_of DESC
        ) AS rn
      FROM valuations v
      JOIN illiquid_assets ia ON ia.id = v.asset_id
      WHERE ia.archived_at IS NULL
    )
    SELECT COALESCE(SUM(value_cents), 0) FROM ranked WHERE rn = 1
  `)) as unknown[][];
  const illiquidCents = num(ill[0]?.[0]);

  const totalCents = liquidCents + illiquidCents;
  return {
    total_usd: totalCents / 100,
    liquid_usd: liquidCents / 100,
    illiquid_usd: illiquidCents / 100,
    total_cents: totalCents,
    liquid_cents: liquidCents,
    illiquid_cents: illiquidCents,
  };
}

type AccountRow = {
  id: string;
  institution: string;
  name: string;
  kind: string;
  currency: string;
  is_liability: number;
  source: string;
  latest_cents: number | null;
  latest_as_of: number | null;
};

export async function listAccounts(d: DB): Promise<AccountRow[]> {
  return rows<AccountRow>(
    d,
    sql`
      SELECT a.id, i.name AS institution, a.name, a.kind, a.currency, a.is_liability, a.source,
        (SELECT balance_cents FROM balance_snapshots WHERE account_id = a.id ORDER BY as_of DESC LIMIT 1) AS latest_cents,
        (SELECT as_of        FROM balance_snapshots WHERE account_id = a.id ORDER BY as_of DESC LIMIT 1) AS latest_as_of
      FROM accounts a
      JOIN institutions i ON i.id = a.institution_id
      WHERE a.archived_at IS NULL
      ORDER BY i.name, a.name
    `,
    ['id', 'institution', 'name', 'kind', 'currency', 'is_liability', 'source', 'latest_cents', 'latest_as_of'],
  );
}

type IlliquidRow = {
  id: string;
  kind: string;
  name: string;
  notes: string | null;
  current_value_cents: number;
  total_cost_basis_cents: number;
  investment_count: number;
};

export async function listIlliquidAssets(d: DB): Promise<IlliquidRow[]> {
  return rows<IlliquidRow>(
    d,
    sql`
      WITH latest_per_leaf AS (
        SELECT v.asset_id, v.value_cents,
          ROW_NUMBER() OVER (
            PARTITION BY v.asset_id, COALESCE(v.investment_id, '__asset_level__')
            ORDER BY v.as_of DESC
          ) AS rn
        FROM valuations v
      )
      SELECT ia.id, ia.kind, ia.name, ia.notes,
        (SELECT COALESCE(SUM(value_cents), 0) FROM latest_per_leaf WHERE asset_id = ia.id AND rn = 1) AS current_value_cents,
        (SELECT COALESCE(SUM(cost_basis_cents), 0) FROM investments WHERE asset_id = ia.id AND archived_at IS NULL) AS total_cost_basis_cents,
        (SELECT COUNT(*) FROM investments WHERE asset_id = ia.id AND archived_at IS NULL) AS investment_count
      FROM illiquid_assets ia
      WHERE ia.archived_at IS NULL
      ORDER BY ia.kind, ia.name
    `,
    ['id', 'kind', 'name', 'notes', 'current_value_cents', 'total_cost_basis_cents', 'investment_count'],
  );
}

export async function getIlliquidAsset(d: DB, assetId: string) {
  const [asset] = await rows<Record<string, unknown>>(
    d,
    sql`SELECT id, kind, name, notes, archived_at, created_at FROM illiquid_assets WHERE id = ${assetId}`,
    ['id', 'kind', 'name', 'notes', 'archived_at', 'created_at'],
  );
  if (!asset) throw new Error(`Illiquid asset not found: ${assetId}`);

  const invs = await rows<Record<string, unknown>>(
    d,
    sql`
      SELECT i.id, i.asset_id, i.security_type, i.round_label, i.shares, i.price_per_share_cents,
        i.cost_basis_cents, i.entry_date, i.created_at,
        (SELECT value_cents FROM valuations WHERE investment_id = i.id ORDER BY as_of DESC LIMIT 1) AS latest_value_cents,
        (SELECT as_of        FROM valuations WHERE investment_id = i.id ORDER BY as_of DESC LIMIT 1) AS latest_as_of
      FROM investments i
      WHERE i.asset_id = ${assetId} AND i.archived_at IS NULL
      ORDER BY i.entry_date DESC
    `,
    ['id', 'asset_id', 'security_type', 'round_label', 'shares', 'price_per_share_cents', 'cost_basis_cents', 'entry_date', 'created_at', 'latest_value_cents', 'latest_as_of'],
  );

  const vals = await rows<Record<string, unknown>>(
    d,
    sql`
      SELECT id, asset_id, investment_id, as_of, value_cents, basis, note, created_at
      FROM valuations WHERE asset_id = ${assetId} ORDER BY as_of DESC LIMIT 50
    `,
    ['id', 'asset_id', 'investment_id', 'as_of', 'value_cents', 'basis', 'note', 'created_at'],
  );

  const fd = await rows<Record<string, unknown>>(
    d,
    sql`
      SELECT asset_id, role, committed_cents, called_cents, distributed_cents, carry_pct, carry_vested_pct, created_at
      FROM fund_details WHERE asset_id = ${assetId}
    `,
    ['asset_id', 'role', 'committed_cents', 'called_cents', 'distributed_cents', 'carry_pct', 'carry_vested_pct', 'created_at'],
  );

  return { asset, investments: invs, valuations: vals, fund_details: fd[0] ?? null };
}

export async function getAccount(d: DB, accountId: string) {
  const [account] = await rows<Record<string, unknown>>(
    d,
    sql`
      SELECT a.id, i.name AS institution, a.name, a.kind, a.currency, a.is_liability, a.source,
        a.plaid_account_id, a.created_at, a.archived_at
      FROM accounts a JOIN institutions i ON i.id = a.institution_id
      WHERE a.id = ${accountId}
    `,
    ['id', 'institution', 'name', 'kind', 'currency', 'is_liability', 'source', 'plaid_account_id', 'created_at', 'archived_at'],
  );
  if (!account) throw new Error(`Account not found: ${accountId}`);

  const snapshots = await rows<Record<string, unknown>>(
    d,
    sql`
      SELECT id, balance_cents, currency, as_of, source, created_at
      FROM balance_snapshots WHERE account_id = ${accountId} ORDER BY as_of DESC LIMIT 100
    `,
    ['id', 'balance_cents', 'currency', 'as_of', 'source', 'created_at'],
  );

  return { account, snapshots };
}
