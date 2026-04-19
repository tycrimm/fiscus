# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`fiscus` is a private family-finance app for two users (Tyler + wife) running entirely on Cloudflare. The current step-by-step roadmap and rationale lives in `NEXT.md` — read it before planning new work. Always start with the lowest unchecked step.

## Two runtimes, one schema

The app code runs in two places against the same Cloudflare D1 database (`fiscus`, id `49e2fc4c-fa79-4c50-b854-15c8a9d4e63d`, region WNAM):

1. **Astro Worker** at `fiscus.crimm.dev` (gated by Cloudflare Access). Read-only UI surface — net worth dashboard, account/asset detail. Accesses D1 via the `env.DB` binding: `import { env } from 'cloudflare:workers'`. Note: Astro 6 removed `Astro.locals.runtime.env` — do not use the old pattern.
2. **Local MCP server** (`src/mcp/server.ts`, stdio transport) — exposes read+write tools to Claude Code. Reaches D1 over the Cloudflare HTTP `/raw` endpoint via Drizzle's sqlite-proxy driver (`src/mcp/d1-http.ts`). Auto-registered via `.mcp.json` at the repo root.

**The shared core is `src/ops/{accounts,private-investments,reads,flows}.ts`** — pure functions taking a Drizzle `DB` handle. They work against the Worker binding *and* the HTTP-proxy DB, so the same code mutates state regardless of which runtime invokes it. When adding new write logic, put it in `src/ops/`.

## Product principle: no manual write forms

All writes happen through Plaid sync (later) or by talking to an agent that calls MCP tools. The web UI never shows a CRUD form. If a future task seems to need one, ask whether an MCP tool would serve better. See `feedback_no_forms` in private memory.

Until Plaid lands, agent-driven writes are the only ingest path. When the user wants data added/updated, call MCP tools (or `wrangler d1 execute --remote` if the MCP server isn't loaded).

## Schema layers (`src/db/schema.ts`)

- **Canonical** (mixed hand-entered + Plaid-projected): `institutions`, `accounts`, `balance_snapshots`, `securities`, `holdings`. `accounts.source` distinguishes manual vs plaid; `plaid_account_id` links back when relevant.
- **Private investments** (hand-entered only; renamed from `illiquid_assets` on 2026-04-19 — the old "illiquid" framing broke down once IPO'd positions entered the picture): `private_investments`, `investments` (one per check/round), `valuations` (append-only marks; `investment_id` is nullable for asset-level marks like "Grandma $50k"), `fund_details` (sidecar for `kind='fund'`). `securities.private_investment_id` bridges an IPO'd position back to its pre-IPO record so cost basis / round history survives.
- **Plaid connection**: `plaid_items` (encrypted access_token + cursor), `plaid_sync_log` (audit trail of sync payloads). Plaid sync writes *straight into canonical tables* via the same `src/ops/*` functions — no parallel `plaid_raw_*` shadow tables.
- **Obligations** (step 8, not yet built): `obligations` for nanny/insurance/car/etc.

Conventions baked in:
- IDs are `crypto.randomUUID()` text.
- Money is `*_cents` integers everywhere; convert dollars→cents at boundaries (`Math.round(x * 100)`).
- Time-series is achieved by **append-only** snapshot tables (`balance_snapshots`, `valuations`) + `ORDER BY as_of DESC LIMIT 1` to read latest. Never UPDATE balances in place.
- `archived_at` for soft-delete; reads filter `WHERE archived_at IS NULL`.

## Drizzle sqlite-proxy gotcha

The MCP-side DB uses `drizzle-orm/sqlite-proxy`, which returns rows as **positional arrays** (not objects). Typed queries (`d.insert().returning()`, `d.select().from()`) get auto-mapped via schema, but raw `sql\`...\`` via `d.all(...)` returns `unknown[][]`. Use the `rows<T>(d, sql, [colNames])` helper in `src/ops/reads.ts` to convert.

## Commands

All commands run from the repo root with Bun. Most wrangler-touching commands need `CLOUDFLARE_API_TOKEN` in `.env` (gitignored); `bun run` auto-loads `.env` so package.json scripts work directly. For ad-hoc `bunx wrangler ...` invocations, prefix with `set -a; source .env; set +a;`.

| | |
| --- | --- |
| `bun run dev` | local Astro dev (vite HMR, talks to local D1) |
| `bun run preview` | `wrangler dev` — full Worker runtime locally |
| `bun run build` | build Worker bundle |
| `bun run deploy` | build + `wrangler deploy` to `fiscus.crimm.dev` |
| `bun run typecheck` | `astro check` (covers .astro + .ts) |
| `bun run db:generate` | regenerate Drizzle migration SQL into `drizzle/` after editing `src/db/schema.ts` |
| `bun run db:migrate:local` | apply migrations to local D1 (`.wrangler/state/v3/d1`) |
| `bun run db:migrate:remote` | apply migrations to production D1 |
| `bun run db:studio` | Drizzle Studio (browse/edit) |
| `bun run cf:types` | regen `worker-configuration.d.ts` (commit it; needed after `wrangler.jsonc` changes) |
| `bun run mcp:dev` | run the MCP server directly (for local debugging) |

`worker-configuration.d.ts` is committed so fresh clones typecheck without running `wrangler types` first.

## Auth and trust boundary

- The deployed site is gated by **Cloudflare Access** (One-Time PIN, allowlist policy `JTC` → `tman7000@gmail.com`). The Worker itself does no auth; it trusts that any inbound request has already cleared Access.
- Wrangler is OAuth-authed to a *different* (work) account. We override per-project via `CLOUDFLARE_API_TOKEN` in `.env` for Tyler's personal account (`3a4e7fc1a9c832398e17f80121fe67f9`). Do not run `wrangler login` — it would clobber the work session.
- The `fiscus-wrangler` token has scopes for Workers, KV, D1, and DNS on the `crimm.dev` zone. If a wrangler command fails with auth code 10000, the token likely needs an additional scope added in the dashboard.

## UI conventions

Read pages only. Light mode locked (`color-scheme: light`). Sharp edges (`border-radius: 0`). Chrome (headings, nav, brand, buttons, labels, table headers) is `text-transform: uppercase` with positive letter-spacing; data (institution names, balances, dates) stays cased. Design tokens live in `src/styles/global.css`; `src/layouts/Shell.astro` wraps pages with the persistent header.

## Git

Conventional commits (`feat:`, `fix:`, `refactor:`, `chore:`, `docs:`, `test:`). Default branch is `main`.
