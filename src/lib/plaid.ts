import { Configuration, PlaidApi, PlaidEnvironments, Products, CountryCode } from 'plaid';

export type PlaidEnv = {
  PLAID_CLIENT_ID: string;
  PLAID_SECRET: string;
  PLAID_ENV: string;
  PLAID_TOKEN_KEY: string;
};

export function makePlaidClient(env: PlaidEnv): PlaidApi {
  const basePath =
    PlaidEnvironments[env.PLAID_ENV as keyof typeof PlaidEnvironments] ??
    PlaidEnvironments.production;
  const config = new Configuration({
    basePath,
    baseOptions: {
      headers: {
        'PLAID-CLIENT-ID': env.PLAID_CLIENT_ID,
        'PLAID-SECRET': env.PLAID_SECRET,
      },
    },
  });
  return new PlaidApi(config);
}

// Required products: ones every institution we'd ever connect must support.
// Transactions is the closest thing to universal; brokerages and banks both have it.
export const REQUIRED_PRODUCTS: Products[] = [Products.Transactions];

// Optional products: enabled when the institution supports them. Listing them
// here doesn't gate Link, so a Mercury (no liabilities) or a credit-card-only
// (no investments) connection still succeeds.
export const OPTIONAL_PRODUCTS: Products[] = [
  Products.Investments,
  Products.Liabilities,
];

export const COUNTRY: CountryCode[] = [CountryCode.Us];

export const LINK_USER_ID = 'fiscus-household';

// Map a Plaid account subtype to our internal account.kind enum.
export function mapAccountKind(
  type: string | null | undefined,
  subtype: string | null | undefined,
): 'checking' | 'savings' | 'brokerage' | 'credit_card' | 'retirement' | 'education' | 'crypto' | 'loan' | 'other' {
  const s = (subtype ?? '').toLowerCase();
  const t = (type ?? '').toLowerCase();
  if (s === 'checking') return 'checking';
  if (s === 'savings' || s === 'cd' || s === 'money market') return 'savings';
  if (t === 'credit') return 'credit_card';
  if (t === 'investment' || t === 'brokerage') {
    if (['529', 'education savings account'].includes(s)) return 'education';
    if (['ira', 'roth', '401k', '401a', '403b', '457b', 'sep ira', 'simple ira', 'roth 401k'].includes(s)) {
      return 'retirement';
    }
    return 'brokerage';
  }
  if (t === 'loan') return 'loan';
  return 'other';
}

export function mapInstitutionKind(
  accountTypes: Array<string | null | undefined>,
): 'bank' | 'brokerage' | 'credit_card' | 'retirement' | 'crypto' | 'other' {
  const types = new Set(accountTypes.map((t) => (t ?? '').toLowerCase()));
  if (types.has('investment') || types.has('brokerage')) return 'brokerage';
  if (types.has('credit')) return 'credit_card';
  if (types.has('depository')) return 'bank';
  return 'other';
}

// Plaid sometimes returns a credit account whose balance reflects what's owed.
// Treat any 'credit' or 'loan' type as a liability for our net-worth math.
export function isLiabilityType(type: string | null | undefined): boolean {
  const t = (type ?? '').toLowerCase();
  return t === 'credit' || t === 'loan';
}

// Plaid security `type` → our `securities.kind` enum.
// Plaid types: equity, etf, mutual fund, fixed income, derivative, cash, crypto, loan, other
export function mapSecurityKind(
  type: string | null | undefined,
): 'public' | 'private' | 'crypto' | 'fund' {
  const t = (type ?? '').toLowerCase();
  if (t === 'crypto') return 'crypto';
  // Mutual funds and ETFs are technically funds, but they trade publicly and
  // we want our 'fund' kind reserved for hand-entered LP positions. Bucket
  // them into 'public'.
  return 'public';
}
