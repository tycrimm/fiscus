#!/usr/bin/env bun
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { makeDb } from './d1-http';
import * as accounts from '../ops/accounts';
import * as illiquid from '../ops/illiquid';
import * as reads from '../ops/reads';
import * as flows from '../ops/flows';

const db = makeDb() as unknown as import('../db').DB; // sqlite-proxy DB is shape-compatible with the D1 binding DB

const server = new McpServer({ name: 'fiscus', version: '0.1.0' });

const json = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
});

// ─── reads ──────────────────────────────────────────────────────────────────

server.registerTool(
  'get_net_worth',
  {
    description: 'Current total net worth: liquid (account balances, liabilities flipped) + illiquid (latest valuations).',
    inputSchema: {},
  },
  async () => json(await reads.netWorth(db)),
);

server.registerTool(
  'list_accounts',
  {
    description: 'List all non-archived accounts with each account\'s latest balance snapshot.',
    inputSchema: {},
  },
  async () => json(await reads.listAccounts(db)),
);

server.registerTool(
  'get_account',
  {
    description: 'Full detail for one account including the last 100 balance snapshots.',
    inputSchema: { accountId: z.string().uuid() },
  },
  async ({ accountId }) => json(await reads.getAccount(db, accountId)),
);

server.registerTool(
  'list_illiquid_assets',
  {
    description: 'List all non-archived illiquid assets with current aggregate value and total cost basis.',
    inputSchema: {},
  },
  async () => json(await reads.listIlliquidAssets(db)),
);

server.registerTool(
  'get_illiquid_asset',
  {
    description: 'Full detail for one illiquid asset: investments, recent valuations, and fund_details sidecar if applicable.',
    inputSchema: { assetId: z.string().uuid() },
  },
  async ({ assetId }) => json(await reads.getIlliquidAsset(db, assetId)),
);

// ─── writes ─────────────────────────────────────────────────────────────────

server.registerTool(
  'add_account',
  {
    description:
      'Add a manual account at an institution. Creates the institution if one with the same (case-insensitive) name does not already exist. Records an initial balance snapshot.',
    inputSchema: {
      institutionName: z.string().min(1).max(200),
      institutionKind: z
        .enum(['bank', 'brokerage', 'credit_card', 'retirement', 'crypto', 'other'])
        .default('other'),
      accountName: z.string().min(1).max(200),
      accountKind: z
        .enum(['checking', 'savings', 'brokerage', 'credit_card', 'retirement', 'education', 'crypto', 'loan', 'other'])
        .default('other'),
      balanceDollars: z.number().finite(),
      isLiability: z.boolean().default(false),
      owner: z.enum(['tyler', 'julianne', 'joint']).default('joint'),
    },
  },
  async (input) => json(await accounts.addAccount(db, input)),
);

server.registerTool(
  'set_account_note',
  {
    description:
      'Set or clear a human-readable note on an account (e.g. "2022 Subaru Outback" on an auto loan, "Business checking" to disambiguate multiple accounts at the same institution). Pass an empty string or null to clear.',
    inputSchema: {
      accountId: z.string().uuid(),
      note: z.string().max(200).nullable(),
    },
  },
  async ({ accountId, note }) => json(await accounts.setAccountNote(db, accountId, note)),
);

server.registerTool(
  'update_balance',
  {
    description:
      'Append a new balance snapshot for an account. Append-only — old snapshots are preserved as time-series.',
    inputSchema: {
      accountId: z.string().uuid(),
      balanceDollars: z.number().finite(),
    },
  },
  async ({ accountId, balanceDollars }) =>
    json(await accounts.recordBalance(db, accountId, balanceDollars)),
);

server.registerTool(
  'add_illiquid_asset',
  {
    description:
      'Create an illiquid asset (private company, fund, loan receivable, 529 plan, gift earmark, or other). Returns the new asset id.',
    inputSchema: {
      kind: z.enum([
        'private_company',
        'fund',
        'loan_receivable',
        'gift_earmark',
        'education_529',
        'other',
      ]),
      name: z.string().min(1).max(200),
      notes: z.string().max(2000).optional(),
      owner: z.enum(['tyler', 'julianne', 'joint']).default('joint'),
    },
  },
  async (input) => json(await illiquid.addIlliquidAsset(db, input)),
);

server.registerTool(
  'add_investment',
  {
    description:
      'Record a check / commit into an illiquid asset. Used for SBS rounds, fund LP contributions, etc. Shares and pricePerShareDollars are optional (SAFEs and notes have no shares). costBasisDollars is required. Also writes an entry valuation (basis="Entry") at cost as of entryDate, so the position shows up in net worth immediately — call record_valuation later to mark it up or down.',
    inputSchema: {
      assetId: z.string().uuid(),
      securityType: z
        .string()
        .max(100)
        .optional()
        .describe('free text, e.g. "Seed Preferred", "A Preferred", "SAFE", "Convertible Note"'),
      roundLabel: z.string().max(200).optional().describe('free text context, e.g. "$35M Series E-2"'),
      shares: z.number().int().optional(),
      pricePerShareDollars: z.number().finite().optional(),
      costBasisDollars: z.number().finite(),
      entryDate: z.string().max(30).describe('ISO date, e.g. "2024-03-08"'),
    },
  },
  async (input) => json(await illiquid.addInvestment(db, input)),
);

server.registerTool(
  'record_valuation',
  {
    description:
      'Append a valuation mark. Pass investmentId to mark a specific check (private co rounds). Omit investmentId to mark the asset as a whole (Grandma $50k, loan balance, 529 plan value). Append-only.',
    inputSchema: {
      assetId: z.string().uuid(),
      investmentId: z.string().uuid().optional(),
      valueDollars: z.number().finite(),
      basis: z
        .string()
        .max(100)
        .optional()
        .describe('e.g. "Last round", "409A", "Own estimate", "Fund report"'),
      note: z.string().max(1000).optional(),
      asOf: z.string().max(30).optional().describe('ISO date; defaults to today'),
    },
  },
  async (input) => json(await illiquid.recordValuation(db, input)),
);

server.registerTool(
  'set_fund_details',
  {
    description:
      'Set or update the fund sidecar (role, committed/called/distributed, carry) for a fund-kind illiquid asset. Upserts.',
    inputSchema: {
      assetId: z.string().uuid(),
      role: z.enum(['lp', 'gp', 'both']),
      committedDollars: z.number().finite().optional(),
      calledDollars: z.number().finite().optional(),
      distributedDollars: z.number().finite().optional(),
      carryPct: z.number().finite().optional(),
      carryVestedPct: z.number().finite().optional(),
    },
  },
  async (input) => json(await illiquid.setFundDetails(db, input)),
);

server.registerTool(
  'archive_illiquid_asset',
  {
    description: 'Soft-archive an illiquid asset so it no longer counts in net worth or lists.',
    inputSchema: { assetId: z.string().uuid() },
  },
  async ({ assetId }) => json(await illiquid.archiveIlliquidAsset(db, assetId)),
);

// ─── expected flows (forward-facing cash events) ────────────────────────────

server.registerTool(
  'list_expected_flows',
  {
    description:
      'List all non-archived expected flows (recurring or one-off forward-looking cash events: paychecks, nanny, capital calls, trust distributions).',
    inputSchema: {},
  },
  async () => json(await flows.listExpectedFlows(db)),
);

server.registerTool(
  'forecast_flows',
  {
    description:
      'Project all active expected flows into individual occurrences within the next N days. Recurring flows expand into multiple instances; one-offs contribute one if in window.',
    inputSchema: { windowDays: z.number().int().min(1).max(365).default(30) },
  },
  async ({ windowDays }) => json(await flows.forecastFlows(db, windowDays)),
);

server.registerTool(
  'add_expected_flow',
  {
    description:
      'Add an expected forward-looking cash event. Use cadence="once" for one-offs (capital call, trust distribution); use weekly/biweekly/monthly/quarterly/annual for recurring (paycheck, nanny, premium). amountExpectedDollars is required; low/high define the range. Optional accountId pins it to a specific account; optional illiquidAssetId links it to a fund (cap calls/distributions).',
    inputSchema: {
      direction: z.enum(['inflow', 'outflow']),
      label: z.string().min(1).max(200),
      cadence: z.enum(['once', 'weekly', 'biweekly', 'monthly', 'quarterly', 'annual']),
      nextExpectedDate: z.string().max(30).describe('ISO date, e.g. "2026-12-31"'),
      amountExpectedDollars: z.number().finite(),
      amountLowDollars: z.number().finite().optional(),
      amountHighDollars: z.number().finite().optional(),
      accountId: z.string().uuid().optional(),
      illiquidAssetId: z.string().uuid().optional(),
      owner: z.enum(['tyler', 'julianne', 'joint']).default('joint'),
      endsDate: z.string().max(30).optional().describe('ISO date; recurring flows stop after this'),
      notes: z.string().max(2000).optional(),
    },
  },
  async (input) => json(await flows.addExpectedFlow(db, input)),
);

server.registerTool(
  'update_expected_flow',
  {
    description:
      'Update one or more fields on an existing expected flow. Pass only the fields you want to change.',
    inputSchema: {
      id: z.string().uuid(),
      label: z.string().min(1).max(200).optional(),
      cadence: z.enum(['once', 'weekly', 'biweekly', 'monthly', 'quarterly', 'annual']).optional(),
      nextExpectedDate: z.string().max(30).optional(),
      amountExpectedDollars: z.number().finite().optional(),
      amountLowDollars: z.number().finite().nullable().optional(),
      amountHighDollars: z.number().finite().nullable().optional(),
      owner: z.enum(['tyler', 'julianne', 'joint']).optional(),
      endsDate: z.string().max(30).nullable().optional(),
      notes: z.string().max(2000).nullable().optional(),
      accountId: z.string().uuid().nullable().optional(),
      illiquidAssetId: z.string().uuid().nullable().optional(),
    },
  },
  async ({ id, ...patch }) => json(await flows.updateExpectedFlow(db, id, patch)),
);

server.registerTool(
  'archive_expected_flow',
  {
    description: 'Soft-archive an expected flow so it stops appearing in forecasts.',
    inputSchema: { id: z.string().uuid() },
  },
  async ({ id }) => json(await flows.archiveExpectedFlow(db, id)),
);

// ─── start ──────────────────────────────────────────────────────────────────

await server.connect(new StdioServerTransport());
