import { drizzle, type AsyncRemoteCallback } from 'drizzle-orm/sqlite-proxy';
import * as schema from '../db/schema';

const ACCOUNT_ID = '3a4e7fc1a9c832398e17f80121fe67f9';
const DATABASE_ID = '49e2fc4c-fa79-4c50-b854-15c8a9d4e63d';
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;

if (!TOKEN) {
  throw new Error('CLOUDFLARE_API_TOKEN missing from environment — ensure .env is loaded');
}

const endpoint = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}/raw`;

const runner: AsyncRemoteCallback = async (sql, params, method) => {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sql, params }),
  });
  const data = (await res.json()) as {
    success: boolean;
    errors?: unknown;
    result?: { results?: { columns: string[]; rows: unknown[][] } }[];
  };
  if (!res.ok || !data.success) {
    throw new Error(`D1 HTTP error: ${JSON.stringify(data.errors ?? data)}`);
  }
  const rows = data.result?.[0]?.results?.rows ?? [];
  if (method === 'get') {
    return { rows: rows[0] ?? [] };
  }
  return { rows };
};

export function makeDb() {
  return drizzle(runner, { schema });
}

export type DB = ReturnType<typeof makeDb>;
