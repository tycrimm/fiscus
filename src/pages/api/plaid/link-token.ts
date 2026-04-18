import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { COUNTRY, REQUIRED_PRODUCTS, OPTIONAL_PRODUCTS, LINK_USER_ID, makePlaidClient } from '../../../lib/plaid';

export const prerender = false;

export const POST: APIRoute = async () => {
  const plaid = makePlaidClient(env as any);
  const resp = await plaid.linkTokenCreate({
    user: { client_user_id: LINK_USER_ID },
    client_name: 'fiscus',
    products: REQUIRED_PRODUCTS,
    optional_products: OPTIONAL_PRODUCTS,
    country_codes: COUNTRY,
    language: 'en',
  });
  return new Response(JSON.stringify({ link_token: resp.data.link_token }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};
