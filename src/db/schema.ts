import { sqliteTable, text, integer, real, unique } from 'drizzle-orm/sqlite-core';

const nowSec = () => Math.floor(Date.now() / 1000);
const uuid = () => crypto.randomUUID();

// ─── canonical (user-facing, hand-entered OR Plaid-projected) ───────────────

export const institutions = sqliteTable('institutions', {
  id: text('id').primaryKey().$defaultFn(uuid),
  name: text('name').notNull(),
  kind: text('kind', {
    enum: ['bank', 'brokerage', 'credit_card', 'retirement', 'crypto', 'other'],
  }).notNull().default('other'),
  plaidInstitutionId: text('plaid_institution_id'),
  createdAt: integer('created_at').notNull().$defaultFn(nowSec),
});

export const accounts = sqliteTable('accounts', {
  id: text('id').primaryKey().$defaultFn(uuid),
  institutionId: text('institution_id').notNull().references(() => institutions.id, { onDelete: 'restrict' }),
  name: text('name').notNull(),
  kind: text('kind', {
    enum: ['checking', 'savings', 'brokerage', 'credit_card', 'retirement', 'education', 'crypto', 'loan', 'other'],
  }).notNull().default('other'),
  currency: text('currency').notNull().default('USD'),
  isLiability: integer('is_liability', { mode: 'boolean' }).notNull().default(false),
  source: text('source', {
    enum: ['manual', 'plaid', 'imported'],
  }).notNull().default('manual'),
  owner: text('owner', {
    enum: ['tyler', 'julianne', 'joint'],
  }).notNull().default('joint'),
  note: text('note'),
  plaidAccountId: text('plaid_account_id'),
  createdAt: integer('created_at').notNull().$defaultFn(nowSec),
  archivedAt: integer('archived_at'),
});

export const balanceSnapshots = sqliteTable('balance_snapshots', {
  id: text('id').primaryKey().$defaultFn(uuid),
  accountId: text('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  balanceCents: integer('balance_cents').notNull(),
  currency: text('currency').notNull().default('USD'),
  asOf: integer('as_of').notNull(),
  source: text('source', {
    enum: ['manual', 'plaid', 'imported'],
  }).notNull().default('manual'),
  createdAt: integer('created_at').notNull().$defaultFn(nowSec),
});

// ─── private investments (agent-entered; direct company equity, SAFEs, LP stakes, coinvestments, carry) ─

export const privateInvestments = sqliteTable('private_investments', {
  id: text('id').primaryKey().$defaultFn(uuid),
  kind: text('kind', {
    enum: ['private_company', 'fund', 'loan_receivable', 'gift_earmark', 'education_529', 'other'],
  }).notNull(),
  name: text('name').notNull(),
  notes: text('notes'),
  owner: text('owner', {
    enum: ['tyler', 'julianne', 'joint'],
  }).notNull().default('joint'),
  // Lifecycle bucket driving default bear/bull band. Nullable → falls back to
  // kind-based bucket (fund→fund, private_company→growth, else→other).
  stage: text('stage', {
    enum: ['seed', 'early', 'growth', 'late', 'fund', 'other'],
  }),
  // Per-asset override multipliers on the stage default. Stored as decimal
  // fractions (0.7 = 70%). Null → use the stage bucket's default.
  bearPct: real('bear_pct'),
  bullPct: real('bull_pct'),
  archivedAt: integer('archived_at'),
  createdAt: integer('created_at').notNull().$defaultFn(nowSec),
});

export const investments = sqliteTable('investments', {
  id: text('id').primaryKey().$defaultFn(uuid),
  assetId: text('asset_id').notNull().references(() => privateInvestments.id, { onDelete: 'cascade' }),
  securityType: text('security_type'),                // "Seed Preferred", "SAFE", "A Preferred", free text
  roundLabel: text('round_label'),                    // "$35M Series E-2"
  shares: integer('shares'),
  pricePerShareCents: integer('price_per_share_cents'),
  costBasisCents: integer('cost_basis_cents').notNull(),
  entryDate: integer('entry_date').notNull(),
  qsbsEligible: integer('qsbs_eligible', { mode: 'boolean' }),  // null = unknown; true/false set per-tranche (each financing qualifies independently under §1202)
  archivedAt: integer('archived_at'),
  createdAt: integer('created_at').notNull().$defaultFn(nowSec),
});

export const valuations = sqliteTable('valuations', {
  id: text('id').primaryKey().$defaultFn(uuid),
  assetId: text('asset_id').notNull().references(() => privateInvestments.id, { onDelete: 'cascade' }),
  investmentId: text('investment_id').references(() => investments.id, { onDelete: 'cascade' }),
  asOf: integer('as_of').notNull(),
  valueCents: integer('value_cents').notNull(),
  basis: text('basis'),                               // "Last round", "409A", "Own estimate", etc.
  note: text('note'),
  createdAt: integer('created_at').notNull().$defaultFn(nowSec),
});

export const fundDetails = sqliteTable('fund_details', {
  assetId: text('asset_id').primaryKey().references(() => privateInvestments.id, { onDelete: 'cascade' }),
  role: text('role', { enum: ['lp', 'gp', 'both'] }).notNull(),
  committedCents: integer('committed_cents').notNull().default(0),
  calledCents: integer('called_cents').notNull().default(0),
  distributedCents: integer('distributed_cents').notNull().default(0),
  carryPct: real('carry_pct'),
  carryVestedPct: real('carry_vested_pct'),
  createdAt: integer('created_at').notNull().$defaultFn(nowSec),
});

// ─── securities + holdings (canonical positions, covers public + private) ───

export const securities = sqliteTable('securities', {
  id: text('id').primaryKey().$defaultFn(uuid),
  kind: text('kind', { enum: ['public', 'private', 'crypto', 'fund'] }).notNull(),
  name: text('name').notNull(),
  ticker: text('ticker'),                             // TSLA, AAPL, BTCUSD
  cusip: text('cusip'),
  plaidSecurityId: text('plaid_security_id'),
  privateInvestmentId: text('private_investment_id').references(() => privateInvestments.id, { onDelete: 'restrict' }),
  createdAt: integer('created_at').notNull().$defaultFn(nowSec),
}, (t) => ({
  plaidSecUnique: unique().on(t.plaidSecurityId),
}));

export const holdings = sqliteTable('holdings', {
  id: text('id').primaryKey().$defaultFn(uuid),
  accountId: text('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  securityId: text('security_id').notNull().references(() => securities.id, { onDelete: 'restrict' }),
  quantityText: text('quantity_text').notNull(),      // decimal as text to preserve precision (e.g. 0.72 BTC)
  valueCents: integer('value_cents').notNull(),       // market value at as_of
  costBasisCents: integer('cost_basis_cents'),
  asOf: integer('as_of').notNull(),
  source: text('source', {
    enum: ['manual', 'plaid', 'imported'],
  }).notNull().default('manual'),
  createdAt: integer('created_at').notNull().$defaultFn(nowSec),
});

// ─── expected flows (forward-looking cash events: paychecks, nanny, cap calls, trust) ─

export const expectedFlows = sqliteTable('expected_flows', {
  id: text('id').primaryKey().$defaultFn(uuid),
  direction: text('direction', { enum: ['inflow', 'outflow'] }).notNull(),
  label: text('label').notNull(),                       // "Nanny", "Paycheck — TC", "Grandma trust"
  accountId: text('account_id').references(() => accounts.id, { onDelete: 'set null' }),
  privateInvestmentId: text('private_investment_id').references(() => privateInvestments.id, { onDelete: 'set null' }),
  owner: text('owner', { enum: ['tyler', 'julianne', 'joint'] }).notNull().default('joint'),

  // amount range — low/high optional, expected required
  amountLowCents: integer('amount_low_cents'),
  amountExpectedCents: integer('amount_expected_cents').notNull(),
  amountHighCents: integer('amount_high_cents'),

  // 'once' = one-off; everything else recurs from nextExpectedAt
  cadence: text('cadence', {
    enum: ['once', 'weekly', 'biweekly', 'monthly', 'quarterly', 'annual'],
  }).notNull(),
  nextExpectedAt: integer('next_expected_at').notNull(),
  endsAt: integer('ends_at'),

  notes: text('notes'),
  archivedAt: integer('archived_at'),
  createdAt: integer('created_at').notNull().$defaultFn(nowSec),
});

// ─── Plaid connection + audit log ───────────────────────────────────────────

export const plaidItems = sqliteTable('plaid_items', {
  id: text('id').primaryKey().$defaultFn(uuid),
  plaidItemId: text('plaid_item_id').notNull().unique(),
  accessTokenEncrypted: text('access_token_encrypted').notNull(),
  institutionPlaidId: text('institution_plaid_id').notNull(),
  institutionName: text('institution_name').notNull(),
  owner: text('owner', {
    enum: ['tyler', 'julianne', 'joint'],
  }).notNull().default('joint'),
  status: text('status', { enum: ['active', 'error', 'revoked'] }).notNull().default('active'),
  cursor: text('cursor'),                             // Plaid transactions sync cursor
  lastSyncAt: integer('last_sync_at'),
  lastError: text('last_error'),
  createdAt: integer('created_at').notNull().$defaultFn(nowSec),
});

export const plaidSyncLog = sqliteTable('plaid_sync_log', {
  id: text('id').primaryKey().$defaultFn(uuid),
  itemId: text('item_id').notNull().references(() => plaidItems.id, { onDelete: 'cascade' }),
  syncedAt: integer('synced_at').notNull().$defaultFn(nowSec),
  kind: text('kind', {
    enum: ['accounts', 'transactions', 'holdings', 'liabilities', 'investments_holdings'],
  }).notNull(),
  ok: integer('ok', { mode: 'boolean' }).notNull(),
  rawJson: text('raw_json').notNull(),
  error: text('error'),
});
