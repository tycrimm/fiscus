export const fmtUSD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

export function money(cents: number | null | undefined, liability = false): string {
  if (cents == null) return '—';
  const dollars = cents / 100;
  return fmtUSD.format(liability ? -dollars : dollars);
}

export function fmtUSDsigned(cents: number): string {
  const neg = cents < 0;
  const abs = fmtUSD.format(Math.abs(cents) / 100);
  return neg ? `−${abs}` : abs;
}

export function fmtDate(sec: number | null | undefined): string {
  return sec
    ? new Date(sec * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : '—';
}

export const prettyKind = (k: string | null | undefined): string =>
  (k ?? '').replace(/_/g, ' ').toUpperCase();

export const pluralize = (n: number, singular: string, plural = `${singular}s`) =>
  `${n} ${n === 1 ? singular : plural}`;
