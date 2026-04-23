// Custom Worker entrypoint: wraps the Astro adapter's fetch handler and
// adds a `scheduled()` handler for Cloudflare Cron Triggers so we can
// refresh Plaid items on a schedule.

import astroApp from '@astrojs/cloudflare/entrypoints/server';
import { drizzle } from 'drizzle-orm/d1';
import { listPlaidItems, syncItemAccountsAndBalances, syncItemHoldings } from './ops/plaid';
import * as schema from './db/schema';
import type { PlaidEnv } from './lib/plaid';

export default {
  fetch: astroApp.fetch,

  async scheduled(
    _event: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(runPlaidSync(env));
  },
} satisfies ExportedHandler<Env>;

async function runPlaidSync(env: Env): Promise<void> {
  const d = drizzle(env.DB, { schema });
  const plaidEnv = env as unknown as PlaidEnv;
  const items = await listPlaidItems(d);

  for (const it of items) {
    // 1. Balances — works for every item (Transactions is required at link)
    try {
      await syncItemAccountsAndBalances(d, plaidEnv, it.id);
    } catch (e) {
      console.error('[cron] balance sync failed', it.id, e);
    }
    // 2. Holdings — only items with the Investments product (brokerages, IRAs).
    //    syncItemHoldings silently returns `{ skipped }` for items without the
    //    product; only real failures throw here.
    try {
      await syncItemHoldings(d, plaidEnv, it.id);
    } catch (e) {
      console.error('[cron] holdings sync failed', it.id, e instanceof Error ? e.message : String(e));
    }
  }
}
