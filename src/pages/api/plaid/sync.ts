import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { drizzle } from 'drizzle-orm/d1';
import { listPlaidItems, syncItemAccountsAndBalances } from '../../../ops/plaid';
import * as schema from '../../../db/schema';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  const body = (await request.json().catch(() => ({}))) as { itemId?: string };
  const d = drizzle(env.DB, { schema });

  const items = body.itemId
    ? [{ id: body.itemId }]
    : (await listPlaidItems(d)).map((i) => ({ id: i.id }));

  const results = [];
  for (const it of items) {
    try {
      const r = await syncItemAccountsAndBalances(d, env as any, it.id);
      results.push({ ok: true, ...r });
    } catch (e) {
      results.push({ itemId: it.id, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return new Response(JSON.stringify({ results }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};
