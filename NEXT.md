# fiscus — what's next

Private family finances app for Tyler + Julianne. Cloudflare-native. Stupid simple, layered.

Each step ends in a deployed, useful thing. Always pick up at the lowest unchecked step.

## Status

- [x] **Step 1** — Astro + Cloudflare Workers, deployed to https://fiscus.crimm.dev, gated by Cloudflare Access (One-Time PIN, allowlist: Tyler + Julianne).
- [x] **Step 2** — D1 (`fiscus`, id `49e2fc4c-fa79-4c50-b854-15c8a9d4e63d`, WNAM), Drizzle ORM. Canonical tables: `institutions`, `accounts`, `balance_snapshots`. Pure write ops in `src/ops/accounts.ts`.
- [x] **Step 3a** — Full schema across all four layers — canonical (`securities`, `holdings` added), illiquid (`illiquid_assets`, `investments`, `valuations`, `fund_details`), Plaid (`plaid_items`, `plaid_sync_log`). Owner column on accounts/illiquid_assets/plaid_items (`tyler` | `julianne` | `joint`).
- [x] **Step 3b** — MCP server (stdio, `src/mcp/server.ts`). 17 tools over D1 HTTP. Registered via `.mcp.json`. Reads: `get_net_worth`, `list_accounts`, `get_account`, `list_illiquid_assets`, `get_illiquid_asset`, `list_expected_flows`, `forecast_flows`. Writes: `add_account`, `update_balance`, `add_illiquid_asset`, `add_investment`, `record_valuation`, `set_fund_details`, `archive_illiquid_asset`, `add_expected_flow`, `update_expected_flow`, `archive_expected_flow`.
- [x] **Step 4** — Plaid Link, AES-256-GCM encrypted access_token at rest, exchange + first sync on connect. `/connect` page: per-owner connect flow (click → owner picker → Plaid Link).
- [x] **Step 5a** — **Daily** Cron sync (2am PT / `0 10 * * *` UTC) via custom worker entrypoint (`src/worker.ts`). Pulls accounts + balances + holdings per Plaid item; appends a balance_snapshot per account and a holdings snapshot per position every run. Webhooks deferred (Access carve-out + JWT verification cost > value at this stage). Switched from `accountsBalanceGet` ($0.10/call) to free `accountsGet` (Plaid's cached snapshot, refreshed ~6h on their side) — keeps daily sync free under PAYG.
- [x] **Step 5b** — Plaid **holdings** sync. Populates `securities` (upsert by `plaid_security_id`) + `holdings` (append-only per sync). Items without the Investments product (Mercury, retail bank checking) gracefully skip via `NO_INVESTMENT_ACCOUNTS` / `PRODUCT_NOT_READY` catches.
- [ ] **Step 5c** — Plaid **transactions** sync via `transactions/sync` (cursor-based, append-only). Cursor stored on `plaid_items.cursor`. Lays groundwork for `expected_flows` reconciliation (step 8c).
- [ ] **Step 6** — Connect remaining institutions via `/connect` (USAA, Schwab, Mercury, IBKR via Plaid). Operational, no code. Blocked on PAYG approval (~24-48h) for Schwab/USAA/Chase, plus per-institution registration forms for Schwab + PNC.
- [ ] **Step 7** — Net worth dashboard polish: time series chart from `balance_snapshots`, daily change, sparklines, allocation breakdown. (NW snapshot rollup is shipped — this is the time-series + visual layer.)
- [ ] **Step 8** — Recurring obligations / burn tracking (nanny, insurance, car payments, subscriptions, paychecks, capital calls, trust distributions). Forward-looking cash events across both directions.
  - [x] **8a** — `expected_flows` schema (one table for both recurring + one-off, both directions). Range columns (low/expected/high). Optional `illiquid_asset_id` link for cap calls / fund distributions. Forecast helper projects flows into a window. MCP tools: `add_expected_flow`, `list_expected_flows`, `forecast_flows`, `update_expected_flow`, `archive_expected_flow`. (Dashboard surface temporarily removed — see 8b.)
  - [ ] **8b** — Dedicated `/flows` page with AR/AP layout (Receiving / Paying side-by-side), recurring rolled up to one line per flow, one-offs as individual rows. Ship once enough entries exist to make it feel real (need at least the trust + a few obligations + Plaid transactions for context).
  - [ ] **8c** — Per-instance overrides (heavier nanny week, late-year paycheck step-down when 401k caps). Defer until we feel the pain — `notes` field is the workaround until then.
  - [ ] **8d** — Reconcile `expected_flows` against Plaid transactions (depends on 5c). Self-calibrating ranges.
- [ ] **Step 9** — **Scenarios / ranges on uncertain illiquid valuations.** `expected_flows` already has low/expected/high columns; this step extends the same pattern to `valuations`. Today `valuations.value_cents` is a single number with no way to express bear vs expected vs bull. Leading idea: add a `case` enum (`'expected' | 'bull' | 'bear'`, default `'expected'`) to `valuations` so an asset can carry multiple concurrent marks; net-worth rollups filter to `case='expected'`. Alt: low/expected/high columns on a single row — simpler but loses "what did I think the bear case was a year ago" history. Decide before the time-series dashboard (step 7) starts showing illiquid bands. (Doesn't apply to `balance_snapshots` — balances are observed, not projected.)

> IBKR Flex Query native API dropped — IBKR goes through Plaid for a uniform integration surface.

## Stack

- **Astro 6** + `@astrojs/cloudflare` 13 (SSR, `output: 'server'`)
- **Cloudflare Workers**, custom domain `fiscus.crimm.dev`
- **D1** for relational data, **R2** for documents (added when needed), **KV** for sessions (auto-provisioned)
- **Drizzle ORM** — chosen over Prisma, lighter bundle on Workers
- **Cloudflare Access** in front of everything (One-Time PIN by email)
- **Plaid** SDK (production, PAYG tier — pending full approval as of 2026-04-18)
- **AES-256-GCM** (Web Crypto) for `plaid_items.access_token_encrypted`
- **Bun** for package mgmt + scripts

## Cloudflare account

- Personal account ID: `3a4e7fc1a9c832398e17f80121fe67f9`
- Zone: `crimm.dev`
- Wrangler OAuth is logged into a *different* account (work). We override per-project via `CLOUDFLARE_API_TOKEN` in `.env` (gitignored). Bun auto-loads `.env` so `bun run deploy` just works.
- Zero Trust team: visible at `one.dash.cloudflare.com`
- Access application: `fiscus` → policy `JTC` (Allow → Tyler + Julianne)

## Product philosophy

- **No manual write forms.** All writes happen via Plaid sync or by talking to an agent (Claude in Claude Code via MCP). The web UI is a read surface. The one exception is `/connect` — Plaid Link is OAuth, not data entry.
- **Two classes of data:**
  1. **Hand-entered** (illiquid, obligations, manual accounts) — land directly via `src/ops/*` functions, callable from MCP.
  2. **Plaid-synced** (accounts, balances, holdings, transactions) — land via Plaid adapters that call the same canonical-layer ops. Raw Plaid payloads kept in `plaid_sync_log` for debugging.
- All append-only snapshot tables (`balance_snapshots`, `valuations`, future `holdings`) — never UPDATE in place. Time-series for free.

## Commands

- `bun run dev` — local Astro dev server
- `bun run build` — build the Worker bundle
- `bun run preview` — `wrangler dev` (full Worker runtime locally)
- `bun run deploy` — build + `wrangler deploy`
- `bun run typecheck` — Astro type check
- `bun run db:generate` — generate Drizzle migration SQL into `drizzle/`
- `bun run db:migrate:local` / `db:migrate:remote` — apply migrations
- `bun run db:studio` — Drizzle Studio
- `bun run cf:types` — regen `worker-configuration.d.ts` (run after wrangler.jsonc changes)
- `bun run mcp:dev` — run the MCP server directly (debugging)
- `bun run secrets:push` — push `.dev.vars` values to Workers Secrets in production

## Security conventions

- All production secrets in **Workers Secrets** (`wrangler secret put NAME`). `.dev.vars` is local-dev only.
- **App-layer encryption** (AES-GCM) for sensitive columns: Plaid `access_token`. Key (`PLAID_TOKEN_KEY`) lives in Workers Secrets — a D1 dump alone leaks nothing usable.
- Conventional commits: `feat:`, `fix:`, `refactor:`, `docs:`, `chore:`, `test:`.
- Drizzle migrations checked into `drizzle/`.

## Data model notes

- Env access at runtime: `import { env } from 'cloudflare:workers'` → `env.DB`, `env.PLAID_CLIENT_ID`, etc. (Astro 6 removed `Astro.locals.runtime.env`.)
- Money stored as integer `*_cents`; display via `Intl.NumberFormat`. Liabilities flipped to negative via `is_liability` flag rather than stored negative.
- Timestamps stored as unix-seconds integers; rendered server-side in `America/Los_Angeles` via `fmtDateTime` in `src/lib/format.ts`.
- Drizzle's `sqlite-proxy` (used by MCP) returns positional arrays for raw `sql\`...\``; the D1 binding (used by Worker) returns objects. The `rows()` helper in `src/ops/reads.ts` handles both shapes.
