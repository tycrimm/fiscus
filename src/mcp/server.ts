#!/usr/bin/env bun
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { makeDb } from './d1-http';
import * as accounts from '../ops/accounts';
import * as illiquid from '../ops/illiquid';
import * as reads from '../ops/reads';

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
    inputSchema: { accountId: z.string() },
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
    inputSchema: { assetId: z.string() },
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
      institutionName: z.string(),
      institutionKind: z
        .enum(['bank', 'brokerage', 'credit_card', 'retirement', 'crypto', 'other'])
        .default('other'),
      accountName: z.string(),
      accountKind: z
        .enum(['checking', 'savings', 'brokerage', 'credit_card', 'retirement', 'crypto', 'loan', 'other'])
        .default('other'),
      balanceDollars: z.number(),
      isLiability: z.boolean().default(false),
    },
  },
  async (input) => json(await accounts.addAccount(db, input)),
);

server.registerTool(
  'update_balance',
  {
    description:
      'Append a new balance snapshot for an account. Append-only — old snapshots are preserved as time-series.',
    inputSchema: {
      accountId: z.string(),
      balanceDollars: z.number(),
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
      name: z.string(),
      notes: z.string().optional(),
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
      assetId: z.string(),
      securityType: z
        .string()
        .optional()
        .describe('free text, e.g. "Seed Preferred", "A Preferred", "SAFE", "Convertible Note"'),
      roundLabel: z.string().optional().describe('free text context, e.g. "$35M Series E-2"'),
      shares: z.number().int().optional(),
      pricePerShareDollars: z.number().optional(),
      costBasisDollars: z.number(),
      entryDate: z.string().describe('ISO date, e.g. "2024-03-08"'),
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
      assetId: z.string(),
      investmentId: z.string().optional(),
      valueDollars: z.number(),
      basis: z
        .string()
        .optional()
        .describe('e.g. "Last round", "409A", "Own estimate", "Fund report"'),
      note: z.string().optional(),
      asOf: z.string().optional().describe('ISO date; defaults to today'),
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
      assetId: z.string(),
      role: z.enum(['lp', 'gp', 'both']),
      committedDollars: z.number().optional(),
      calledDollars: z.number().optional(),
      distributedDollars: z.number().optional(),
      carryPct: z.number().optional(),
      carryVestedPct: z.number().optional(),
    },
  },
  async (input) => json(await illiquid.setFundDetails(db, input)),
);

server.registerTool(
  'archive_illiquid_asset',
  {
    description: 'Soft-archive an illiquid asset so it no longer counts in net worth or lists.',
    inputSchema: { assetId: z.string() },
  },
  async ({ assetId }) => json(await illiquid.archiveIlliquidAsset(db, assetId)),
);

// ─── start ──────────────────────────────────────────────────────────────────

await server.connect(new StdioServerTransport());
