import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

const nowSec = () => Math.floor(Date.now() / 1000);
const uuid = () => crypto.randomUUID();

export const institutions = sqliteTable('institutions', {
  id: text('id').primaryKey().$defaultFn(uuid),
  name: text('name').notNull(),
  kind: text('kind', {
    enum: ['bank', 'brokerage', 'credit_card', 'retirement', 'crypto', 'other'],
  }).notNull().default('other'),
  createdAt: integer('created_at').notNull().$defaultFn(nowSec),
});

export const accounts = sqliteTable('accounts', {
  id: text('id').primaryKey().$defaultFn(uuid),
  institutionId: text('institution_id').notNull().references(() => institutions.id, { onDelete: 'restrict' }),
  name: text('name').notNull(),
  kind: text('kind', {
    enum: ['checking', 'savings', 'brokerage', 'credit_card', 'retirement', 'crypto', 'loan', 'other'],
  }).notNull().default('other'),
  currency: text('currency').notNull().default('USD'),
  isLiability: integer('is_liability', { mode: 'boolean' }).notNull().default(false),
  source: text('source', {
    enum: ['manual', 'plaid', 'ibkr', 'imported'],
  }).notNull().default('manual'),
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
    enum: ['manual', 'plaid', 'ibkr', 'imported'],
  }).notNull().default('manual'),
  createdAt: integer('created_at').notNull().$defaultFn(nowSec),
});
