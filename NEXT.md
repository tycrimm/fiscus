# fiscus — what's next

Private family finances app for Tyler + wife. Cloudflare-native. Stupid simple, layered.

Each step ends in a deployed, useful thing. Always pick up at the lowest unchecked step.

## Status

- [x] **Step 1** — Astro + Cloudflare Workers, deployed to https://fiscus.crimm.dev, gated by Cloudflare Access (One-Time PIN, allowlist: tman7000@gmail.com)
- [x] **Step 2** — D1 (`fiscus`, id `49e2fc4c-fa79-4c50-b854-15c8a9d4e63d`, WNAM), Drizzle ORM, schema: `institutions` + `accounts` + `balance_snapshots`. Home shows net worth + account list. Write ops live in `src/ops/accounts.ts` (pure fns, no UI).
- [ ] **Step 3a** — Illiquid assets schema — **schema only, no UI**. Tables: `illiquid_assets`, `investments`, `valuations`, `fund_details`. Also: `holdings`, `securities` (for brokerage positions, used by Plaid later).
- [x] **Step 3b** — MCP server (local stdio, `src/mcp/server.ts`). 12 tools over Cloudflare's D1 HTTP API. Registered via `.mcp.json` at repo root. Read: `get_net_worth`, `list_accounts`, `get_account`, `list_illiquid_assets`, `get_illiquid_asset`. Write: `add_account`, `update_balance`, `add_illiquid_asset`, `add_investment`, `record_valuation`, `set_fund_details`, `archive_illiquid_asset`.
- [ ] **Step 4** — Plaid Link + first sandbox Item (encrypted access_token, on-demand balance/holdings pull)
- [ ] **Step 5** — Plaid webhooks + Cloudflare Cron Trigger (~6h backstop)
- [ ] **Step 6** — Connect remaining Plaid institutions (USAA, Schwab, Mercury, **IBKR via Plaid**) — needs Plaid production approval
- [ ] **Step 7** — Net worth dashboard (totals, allocation breakdown, time series, daily change)
- [ ] **Step 8** — Recurring obligations / burn tracking (nanny, insurance, car payments, subscriptions)

> IBKR Flex Query native API dropped — IBKR goes through Plaid too for a uniform integration surface.

## Stack

- **Astro 6** + `@astrojs/cloudflare` 13 (SSR, `output: 'server'`)
- **Cloudflare Workers**, custom domain `fiscus.crimm.dev`
- **D1** for relational data, **R2** for documents (added when needed), **KV** for sessions (auto-provisioned by adapter)
- **Drizzle ORM** — chosen over Prisma, lighter bundle on Workers
- **Cloudflare Access** in front of everything (One-Time PIN by email; can add Google/Apple/passkeys later)
- **Bun** for package mgmt + scripts

## Cloudflare account

- Personal account ID: `3a4e7fc1a9c832398e17f80121fe67f9`
- Zone: `crimm.dev`
- Wrangler OAuth is logged into a *different* account (SHV); we override per-project via `CLOUDFLARE_API_TOKEN` in `.env` (gitignored). Bun auto-loads `.env` so `bun run deploy` just works.
- Zero Trust team: (set during Step 1; visible at `one.dash.cloudflare.com`)
- Access application: `fiscus` → policy `JTC` (Allow → `tman7000@gmail.com`)

## Product philosophy

- **No manual write forms.** All writes happen via Plaid sync or by talking to an agent (Claude in Claude Code, or the MCP-enabled agent once 3b ships). The web UI is a read surface: net worth, dashboard, account detail.
- **Two classes of data:**
  1. **Hand-entered** (illiquid, obligations, initial balances before Plaid) — land directly in canonical tables via `src/ops/*` functions.
  2. **Plaid-synced** (accounts, balances, holdings, transactions) — land via Plaid adapters that call the same canonical-layer ops. Raw Plaid payloads kept in an audit log (`plaid_sync_log`) for debugging.
- Until MCP (step 3b) lands, Claude makes writes via `wrangler d1 execute --remote --command "INSERT INTO ..."` during conversation.

## Outstanding side-items

- [ ] **Plaid developer signup** (Tyler) — dev account created; start in Sandbox, then submit for production review (~1-2 weeks).
- [ ] **Wife's email** — not yet on the Access allowlist. Add to JTC policy when ready.

## Security conventions

- All production secrets in **Workers Secrets** (`wrangler secret put NAME`). `.env` is local-dev only.
- **App-layer encryption** (AES-GCM) for sensitive columns: Plaid `access_token`, account numbers. Key lives in Workers Secrets — a D1 dump alone leaks nothing usable.
- Conventional commits: `feat:`, `fix:`, `refactor:`, `docs:`, `chore:`, `test:`.
- Drizzle migrations checked into `drizzle/` (when Step 2 lands).

## Commands

- `bun run dev` — local Astro dev server
- `bun run build` — build the Worker bundle
- `bun run preview` — `wrangler dev` (full Worker runtime locally)
- `bun run deploy` — build + `wrangler deploy` (reads `CLOUDFLARE_API_TOKEN` from `.env`)
- `bun run typecheck` — Astro type check
- `bun run db:generate` — generate Drizzle migration SQL into `drizzle/` from `src/db/schema.ts`
- `bun run db:migrate:local` — apply migrations to local D1 (`.wrangler/state/v3/d1`)
- `bun run db:migrate:remote` — apply migrations to production D1
- `bun run db:studio` — Drizzle Studio (browse/edit D1 data)
- `bun run cf:types` — regenerate `worker-configuration.d.ts` (run after changing `wrangler.jsonc`)

## Data model notes

- Env access at runtime: `import { env } from 'cloudflare:workers'` → `env.DB`, `env.SESSION`, etc. (Astro 6 removed `Astro.locals.runtime.env`.)
- Money stored as integer `balance_cents`; display via `Intl.NumberFormat`. Liabilities flipped to negative via `is_liability` flag rather than stored negative.
- `balance_snapshots` is append-only — every balance update is a new row. Time-series comes for free.
