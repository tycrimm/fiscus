# fiscus — what's next

Private family finances app for Tyler + Julianne. Cloudflare-native. Stupid simple, layered. Each step ends in a deployed, useful thing. Always pick up at the lowest unchecked step.

## Shipped

- [x] **1** — Astro + Workers deployed to `fiscus.crimm.dev`, gated by Cloudflare Access (OTP, allowlist: Tyler + Julianne)
- [x] **2** — D1 + Drizzle, canonical tables (`institutions`, `accounts`, `balance_snapshots`)
- [x] **3a** — Full schema across all four layers: canonical (+ `securities`, `holdings`), private investments (`private_investments`, `investments`, `valuations`, `fund_details`), Plaid (`plaid_items`, `plaid_sync_log`). Owner column on accounts/private_investments/plaid_items: `tyler | julianne | joint`
- [x] **3b** — MCP server (stdio, `src/mcp/server.ts`) — 21 tools over D1 HTTP, auto-registered via `.mcp.json`
- [x] **4** — Plaid Link + AES-256-GCM encrypted access tokens, `/connect` owner-picker flow
- [x] **5a** — Daily cron balance sync (2am PT, `0 10 * * *` UTC) via `src/worker.ts` → appends one `balance_snapshot` per account per run
- [x] **5b** — Plaid holdings sync — upserts `securities`, appends `holdings`; items without Investments product skip gracefully
- [x] **7** — Dashboard: net worth sparkline + hover crosshair/readout, 1d/1w/1m/ytd/1y deltas, allocation mix, top-N concentration, ledger sections rolled up by institution. Whole-dollar formatting, tabular alignment
- [x] **8a** — `expected_flows` schema (recurring + one-off, both directions, low/expected/high ranges, optional `private_investment_id` for cap calls / fund distributions). MCP tools: `add/list/update/archive_expected_flow`, `forecast_flows`

## Next (recommended order)

- [ ] **5c — Plaid transactions sync.** `transactions/sync` cursor-based, cursor stored on `plaid_items.cursor`. Groundwork for 8d reconciliation. Biggest unlock: moves us from "what we have" to "what's moving."
- [ ] **8b — `/flows` page.** AR/AP layout (Receiving / Paying side-by-side), recurring rolled up to one line per flow, one-offs as individual rows. Page skeleton in `src/pages/flows.astro` is WIP.
- [ ] **9 — Scenario ranges on valuations.** `expected_flows` already carries low/expected/high; extend the same pattern to `valuations`. Today `valuations.value_cents` is a single number — no way to express bear vs expected vs bull. Leading idea: add a `case` enum (`'expected' | 'bull' | 'bear'`, default `'expected'`) so an asset can carry multiple concurrent marks; net-worth rollups filter to `case='expected'`. Alt: low/expected/high columns on a single row — simpler but loses "what did I think the bear case was a year ago" history. Decide before bands show up on the dashboard. (Doesn't apply to `balance_snapshots` — balances are observed, not projected.)
- [ ] **8c — Per-instance flow overrides.** Heavier nanny week, late-year paycheck step-down when 401k caps. Defer until we feel the pain — `notes` field is the workaround.
- [ ] **8d — Reconcile `expected_flows` vs Plaid transactions.** Self-calibrating ranges. Depends on 5c.
- [ ] **6 — Connect remaining institutions.** USAA, Schwab, Mercury, IBKR via `/connect`. Operational, no code. Blocked on PAYG approval (~24-48h) + per-institution registration forms (Schwab, PNC).
  - [ ] **Principal (401k)** — Plaid Link fails post-MFA. Item never reaches `plaid_items` and nothing lands in `plaid_sync_log`, so failure is inside the Plaid iframe or in `/api/plaid/exchange` before the first DB write. Retry with Network tab + `wrangler tail` to capture the status (`plaid exit:` vs `exchange failed:`) and the actual Plaid error code.

## Rationale worth remembering

- **Daily sync uses free `accountsGet`, not `accountsBalanceGet` ($0.10/call).** Plaid refreshes its cached snapshot ~6h on their side, which is plenty for daily granularity. Switched pre-launch to stay free under PAYG. Don't "upgrade" without a reason — it's a cost trap, not a feature.
- **Plaid webhooks deferred.** Cloudflare Access carve-out + JWT verification cost > value at daily-sync scale. Revisit if sync freshness becomes a problem.
- **IBKR via Plaid, not Flex Query.** Native IBKR Flex Query dropped in favor of a uniform Plaid integration surface.
- **`illiquid_assets` → `private_investments` rename (2026-04-19).** The "illiquid" framing broke down once IPO'd positions entered the picture. `securities.private_investment_id` bridges IPO'd positions back to their pre-IPO record so cost basis / round history survives.
- **No `plaid_raw_*` shadow tables.** Plaid sync writes straight into canonical tables via `src/ops/*`. Raw payloads are kept in `plaid_sync_log` for debugging only.

## Stack

- **Astro 6** + `@astrojs/cloudflare` 13 (SSR, `output: 'server'`)
- **Cloudflare Workers** on `fiscus.crimm.dev`, **D1** (relational), **R2** (docs — wired, not yet used), **KV** (sessions, auto)
- **Drizzle ORM** — lighter bundle on Workers than Prisma
- **Cloudflare Access** in front of everything (OTP by email)
- **Plaid** SDK (production, PAYG)
- **AES-256-GCM** (Web Crypto) for `plaid_items.access_token_encrypted`
- **Bun** for package mgmt + scripts

## Cloudflare account

- Personal account ID: `3a4e7fc1a9c832398e17f80121fe67f9`
- Zone: `crimm.dev`
- Wrangler OAuth is logged into a *different* (work) account. We override per-project via `CLOUDFLARE_API_TOKEN` in `.env` (gitignored). Bun auto-loads `.env` so `bun run deploy` just works. Do not run `wrangler login` — it would clobber the work session.
- `fiscus-wrangler` token scopes: Workers, KV, D1, DNS on `crimm.dev`. If a wrangler command fails with auth code 10000, the token likely needs an additional scope added in the dashboard.
- Zero Trust: `one.dash.cloudflare.com`. Access application `fiscus` → policy `JTC` (Allow → Tyler + Julianne).
