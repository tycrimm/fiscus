#!/usr/bin/env bun
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { makeDb } from './d1-http';
import * as accounts from '../ops/accounts';
import * as privateInv from '../ops/private-investments';
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
    description: 'Current total net worth: liquid (account balances, liabilities flipped) + private investments (derived from rounds × latest PPS, with manual override marks applied).',
    inputSchema: {},
  },
  async () => json(await reads.netWorth(db)),
);

server.registerTool(
  'get_net_worth_series',
  {
    description:
      'Daily net worth time series from earliest snapshot through today (PT). Each point: liquid_cents, private_cents, total_cents. Carry-forward semantics: a day inherits the prior day\'s balance for any account that didn\'t snapshot that day.',
    inputSchema: {},
  },
  async () => json(await reads.netWorthSeries(db)),
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
  'list_private_investments',
  {
    description: 'List all non-archived private investments with current aggregate value and total cost basis.',
    inputSchema: {},
  },
  async () => json(await reads.listPrivateInvestments(db)),
);

server.registerTool(
  'get_private_investment',
  {
    description: 'Full detail for one private investment: rounds/checks, recent valuations, and fund_details sidecar if applicable.',
    inputSchema: { assetId: z.string().uuid() },
  },
  async ({ assetId }) => json(await reads.getPrivateInvestment(db, assetId)),
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
  'set_account_owner',
  {
    description:
      'Change the owner of an account (tyler, julianne, or joint). Use when a card/loan/account was mis-attributed at creation.',
    inputSchema: {
      accountId: z.string().uuid(),
      owner: z.enum(['tyler', 'julianne', 'joint']),
    },
  },
  async ({ accountId, owner }) => json(await accounts.setAccountOwner(db, accountId, owner)),
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
  'add_private_investment',
  {
    description:
      'Create a private investment (private company, fund, loan receivable, 529 plan, gift earmark, or other). Returns the new asset id. Stage (seed/early/growth/late/fund/other) drives the default bear/bull band on the dashboard — set it if known. bearPct/bullPct override the stage default when you have specific conviction (e.g. 0.8 / 1.4 for a tight-band late-stage name).',
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
      stage: z.enum(['seed', 'early', 'growth', 'late', 'fund', 'other']).optional(),
      bearPct: z.number().finite().min(0).max(1).optional().describe('0.7 = bear case is 70% of expected'),
      bullPct: z.number().finite().min(1).max(20).optional().describe('1.5 = bull case is 150% of expected'),
    },
  },
  async (input) => json(await privateInv.addPrivateInvestment(db, input)),
);

server.registerTool(
  'update_private_investment',
  {
    description:
      'Update fields on an existing private investment. Pass only the fields you want to change. Most common use: set `stage` to drive scenario bands (seed → ±wide, late → ±tight), or set per-asset `bearPct`/`bullPct` to override the stage default. Pass `stage: null` to clear stage and fall back to kind-based defaults.',
    inputSchema: {
      id: z.string().uuid(),
      name: z.string().min(1).max(200).optional(),
      notes: z.string().max(2000).nullable().optional(),
      owner: z.enum(['tyler', 'julianne', 'joint']).optional(),
      kind: z.enum([
        'private_company',
        'fund',
        'loan_receivable',
        'gift_earmark',
        'education_529',
        'other',
      ]).optional(),
      stage: z.enum(['seed', 'early', 'growth', 'late', 'fund', 'other']).nullable().optional(),
      bearPct: z.number().finite().min(0).max(1).nullable().optional(),
      bullPct: z.number().finite().min(1).max(20).nullable().optional(),
    },
  },
  async ({ id, ...patch }) => json(await privateInv.updatePrivateInvestment(db, id, patch)),
);

server.registerTool(
  'add_investment',
  {
    description:
      'Record a check / commit into a private investment. Used for SBS rounds, fund LP contributions, etc. Shares and pricePerShareDollars are optional (SAFEs and notes have no shares). costBasisDollars is required. Current value is derived automatically: round.shares × latest_round_PPS, summed across rounds; no need to write a follow-up valuation. Use record_valuation only when you want to override the derivation (conservative mark, secondary price, write-down, fund NAV, non-share asset). Set qsbsEligible per IRC §1202 — each financing round qualifies independently. Pass fundedAt=null to log a committed-but-uncalled allocation (pending wire) — it shows as outstanding capital and does not contribute to current value or cost basis until funded; pending rounds DO still contribute their PPS as the latest mark. After adding, infer stage from roundLabel (Series A→early, B→early/growth, C→growth, D+/pre-IPO→late) and call update_private_investment if the parent stage has drifted — stage drives the bear/bull scenario bands and stale stage means stale risk framing.',
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
      fundedAt: z
        .string()
        .max(30)
        .nullable()
        .optional()
        .describe('ISO date the wire cleared. Default = entryDate. Pass null for pending/uncalled.'),
      qsbsEligible: z.boolean().optional().describe('§1202 QSBS eligibility for this specific tranche'),
    },
  },
  async (input) => json(await privateInv.addInvestment(db, input)),
);

server.registerTool(
  'update_investment',
  {
    description:
      'Update fields on an existing investment (check / round). Pass only the fields you want to change. Use to relabel rounds (e.g. seed mis-tagged as Series A), set qsbsEligible, fix shares/price, or correct entry date. Pass fundedAt with a date to mark a pending tranche as funded (wire cleared); pass null to revert to pending/uncalled. Current value derives from the round fields automatically.',
    inputSchema: {
      id: z.string().uuid(),
      securityType: z.string().max(100).nullable().optional(),
      roundLabel: z.string().max(200).nullable().optional(),
      shares: z.number().int().nullable().optional(),
      pricePerShareDollars: z.number().finite().nullable().optional(),
      costBasisDollars: z.number().finite().optional(),
      entryDate: z.string().max(30).optional().describe('ISO date'),
      fundedAt: z
        .string()
        .max(30)
        .nullable()
        .optional()
        .describe('ISO date the wire cleared, or null to mark pending/uncalled.'),
      qsbsEligible: z.boolean().nullable().optional(),
    },
  },
  async ({ id, ...patch }) => json(await privateInv.updateInvestment(db, id, patch)),
);

server.registerTool(
  'record_valuation',
  {
    description:
      'Append a manual valuation override. Only use when you want to override the default derivation (round.shares × latest_round_PPS). Common uses: fund NAVs, non-share holdings (Grandma $50k, loan balance, 529 plan), secondary-sale evidence that disagrees with last-round PPS, conservative write-downs. Pass investmentId to override a specific round; omit to override the whole asset value. Append-only.',
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
  async (input) => json(await privateInv.recordValuation(db, input)),
);

server.registerTool(
  'update_valuation',
  {
    description:
      'Correct an existing valuation row. Use to fix a mark (drop/add dollars), update basis/note, re-date, or relink to a specific investment. Prefer this over appending a new valuation when correcting an error — keeps the time-series clean. Append a fresh record_valuation when the asset genuinely re-marked.',
    inputSchema: {
      id: z.string().uuid(),
      valueDollars: z.number().finite().optional(),
      basis: z.string().max(100).nullable().optional(),
      note: z.string().max(1000).nullable().optional(),
      asOf: z.string().max(30).optional().describe('ISO date'),
      investmentId: z.string().uuid().nullable().optional(),
    },
  },
  async ({ id, ...patch }) => json(await privateInv.updateValuation(db, id, patch)),
);

server.registerTool(
  'set_fund_details',
  {
    description:
      'Set or update the fund sidecar (role, committed/called/distributed, carry) for a fund-kind private investment. Upserts.',
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
  async (input) => json(await privateInv.setFundDetails(db, input)),
);

server.registerTool(
  'archive_private_investment',
  {
    description: 'Soft-archive a private investment so it no longer counts in net worth or lists.',
    inputSchema: { assetId: z.string().uuid() },
  },
  async ({ assetId }) => json(await privateInv.archivePrivateInvestment(db, assetId)),
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
      'Add an expected forward-looking cash event. Use cadence="once" for one-offs (capital call, trust distribution); use weekly/biweekly/monthly/quarterly/annual for recurring (paycheck, nanny, premium). amountExpectedDollars is required; low/high define the range. Optional accountId pins it to a specific account; optional privateInvestmentId links it to a fund (cap calls/distributions).',
    inputSchema: {
      direction: z.enum(['inflow', 'outflow']),
      label: z.string().min(1).max(200),
      cadence: z.enum(['once', 'weekly', 'biweekly', 'monthly', 'quarterly', 'annual']),
      nextExpectedDate: z.string().max(30).describe('ISO date, e.g. "2026-12-31"'),
      amountExpectedDollars: z.number().finite(),
      amountLowDollars: z.number().finite().optional(),
      amountHighDollars: z.number().finite().optional(),
      accountId: z.string().uuid().optional(),
      privateInvestmentId: z.string().uuid().optional(),
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
      privateInvestmentId: z.string().uuid().nullable().optional(),
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
