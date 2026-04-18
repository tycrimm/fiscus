// AES-256-GCM encryption for sensitive columns (Plaid access_token, etc.).
// Key in `PLAID_TOKEN_KEY` (32 bytes, base64). Same code runs in Workers and Node 19+.

const ALGO = 'AES-GCM';
const IV_BYTES = 12;

const b64ToBytes = (b64: string): Uint8Array => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

const bytesToB64 = (bytes: Uint8Array): string => {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
};

async function importKey(b64Key: string): Promise<CryptoKey> {
  const raw = b64ToBytes(b64Key);
  if (raw.length !== 32) {
    throw new Error(`PLAID_TOKEN_KEY must be 32 bytes (got ${raw.length})`);
  }
  return crypto.subtle.importKey('raw', raw as BufferSource, { name: ALGO }, false, ['encrypt', 'decrypt']);
}

export async function encryptString(plaintext: string, b64Key: string): Promise<string> {
  const key = await importKey(b64Key);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: ALGO, iv: iv as BufferSource },
      key,
      new TextEncoder().encode(plaintext) as BufferSource,
    ),
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return bytesToB64(out);
}

export async function decryptString(encrypted: string, b64Key: string): Promise<string> {
  const key = await importKey(b64Key);
  const combined = b64ToBytes(encrypted);
  const iv = combined.slice(0, IV_BYTES);
  const ct = combined.slice(IV_BYTES);
  const pt = await crypto.subtle.decrypt(
    { name: ALGO, iv: iv as BufferSource },
    key,
    ct as BufferSource,
  );
  return new TextDecoder().decode(pt);
}
