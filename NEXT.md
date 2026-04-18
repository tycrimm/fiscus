# fiscus — what's next

Private family finances app for Tyler + wife. Cloudflare-native. Stupid simple, layered.

Each step ends in a deployed, useful thing. Always pick up at the lowest unchecked step.

## Status

- [x] **Step 1** — Astro + Cloudflare Workers, deployed to https://fiscus.crimm.dev, gated by Cloudflare Access (One-Time PIN, allowlist: tman7000@gmail.com)
- [ ] **Step 2** — D1 + Drizzle + manual accounts CRUD (institutions, accounts, balance_snapshots; form to add account + balance; net-worth total on home)
- [ ] **Step 3** — Illiquid assets schema (private company positions, fund LP/GP/carry, valuation_events; manual entry UI)
- [ ] **Step 4** — Plaid Link + first sandbox account (server link_token, client Link, exchange public_token, AES-GCM encrypted access_token in D1, on-demand balance/tx pull)
- [ ] **Step 5** — Plaid webhooks + Cloudflare Cron Trigger backstop (~6h cadence, idempotent upserts)
- [ ] **Step 6** — Connect remaining Plaid institutions (USAA, Schwab, Mercury) — needs Plaid production approval
- [ ] **Step 7** — IBKR Flex Query integration (positions, NAV, trades, dividends; separate creds in Workers Secrets)
- [ ] **Step 8** — Net worth dashboard (totals, allocation breakdown, time series from balance_snapshots)
- [ ] **Step 9** — MCP server for agent read access (writes only later, scoped narrowly)

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

## Outstanding side-items

- [ ] **Plaid developer signup** (Tyler) — start in Sandbox, then submit for production review (~1-2 weeks). Needed before Step 4 finishes useful work and before Step 6 can begin.
- [ ] **Wife's email** — not yet on the Access allowlist. Add to JTC policy when ready.
- [ ] **IBKR Flex Query report shape** — decide which fields to pull before Step 7.

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
