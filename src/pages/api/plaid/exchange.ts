import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { drizzle } from 'drizzle-orm/d1';
import { makePlaidClient } from '../../../lib/plaid';
import { createPlaidItem, syncItemAccountsAndBalances } from '../../../ops/plaid';
import * as schema from '../../../db/schema';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  const body = (await request.json()) as {
    public_token: string;
    institution?: { institution_id?: string; name?: string };
    owner?: 'tyler' | 'julianne' | 'joint';
  };
  if (!body?.public_token) {
    return new Response(JSON.stringify({ error: 'public_token required' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }
  const owner = body.owner ?? 'joint';
  if (!['tyler', 'julianne', 'joint'].includes(owner)) {
    return new Response(JSON.stringify({ error: 'invalid owner' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  try {
    const plaid = makePlaidClient(env as any);
    const exchange = await plaid.itemPublicTokenExchange({ public_token: body.public_token });
    const accessToken = exchange.data.access_token;
    const plaidItemId = exchange.data.item_id;

    const itemResp = await plaid.itemGet({ access_token: accessToken });
    const institutionPlaidId =
      body.institution?.institution_id ?? itemResp.data.item.institution_id ?? 'unknown';
    let institutionName = body.institution?.name ?? 'Unknown';
    if (institutionPlaidId && institutionPlaidId !== 'unknown') {
      try {
        const inst = await plaid.institutionsGetById({
          institution_id: institutionPlaidId,
          country_codes: ['US' as any],
        });
        institutionName = inst.data.institution.name ?? institutionName;
      } catch {
        // fall back to metadata name
      }
    }

    const d = drizzle(env.DB, { schema });
    const item = await createPlaidItem(d, env as any, {
      accessToken,
      plaidItemId,
      institutionPlaidId,
      institutionName,
      owner,
    });

    const sync = await syncItemAccountsAndBalances(d, env as any, item.id);
    // Strip ciphertext from the response — useless without the key, but still unnecessary.
    const { accessTokenEncrypted: _omit, ...safeItem } = item;
    return new Response(JSON.stringify({ item: safeItem, sync }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  } catch (e) {
    console.error('[exchange] failed', e);
    return new Response(JSON.stringify({ error: 'exchange failed' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }
};
