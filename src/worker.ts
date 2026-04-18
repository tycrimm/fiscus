// Custom Worker entrypoint: wraps the Astro adapter's fetch handler and
// adds a `scheduled()` handler for Cloudflare Cron Triggers so we can
// refresh Plaid items on a schedule.

import astroApp from '@astrojs/cloudflare/entrypoints/server';
import { drizzle } from 'drizzle-orm/d1';
import { listPlaidItems, syncItemAccountsAndBalances } from './ops/plaid';
import * as schema from './db/schema';

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
  const items = await listPlaidItems(d);
  for (const it of items) {
    try {
      await syncItemAccountsAndBalances(d, env as unknown as import('./lib/plaid').PlaidEnv, it.id);
    } catch (e) {
      console.error('[cron] plaid sync failed', it.id, e);
    }
  }
}
