// Whole dollars for display — the cents we store are the source of truth,
// but $14,891 reads faster than $14,890.50 at portfolio-sized amounts. For
// true sub-dollar precision (per-share prices, etc.) use a local formatter.
export const fmtUSD = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

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

const TZ = 'America/Los_Angeles';

export function fmtDate(sec: number | null | undefined): string {
  return sec
    ? new Date(sec * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: TZ })
    : '—';
}

// YYYY-MM-DD math. UTC so day boundaries don't drift across TZ changes.
export function shiftYmd(ymd: string, deltaDays: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d) + deltaDays * 86400000);
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`;
}

// "Mar 5" from a YYYY-MM-DD string (used on dense daily-tick axes).
export function fmtTickMonthDay(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', timeZone: 'UTC',
  });
}

// "Mar '25" from unix seconds (used on sparse time-scaled axes).
export function fmtTickMonthYearShort(sec: number): string {
  return new Date(sec * 1000).toLocaleDateString('en-US', {
    month: 'short', year: '2-digit', timeZone: 'UTC',
  });
}

// Compact relative time. Past → "5m ago" / "2h ago" / "3d ago".
// Future → "in 5m" / "in 2h". Anything under a minute is "just now".
export function fmtRelative(sec: number | null | undefined): string {
  if (!sec) return '—';
  const diff = sec - Math.floor(Date.now() / 1000);
  const abs = Math.abs(diff);
  let val: string;
  if (abs < 60) return 'just now';
  if (abs < 3600) val = `${Math.round(abs / 60)}m`;
  else if (abs < 86400) val = `${Math.round(abs / 3600)}h`;
  else if (abs < 86400 * 30) val = `${Math.round(abs / 86400)}d`;
  else val = `${Math.round(abs / (86400 * 30))}mo`;
  return diff < 0 ? `${val} ago` : `in ${val}`;
}

export function fmtDateTime(sec: number | null | undefined): string {
  return sec
    ? new Date(sec * 1000).toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZone: TZ,
      })
    : '—';
}

const KIND_DISPLAY: Record<string, string> = {
  education: '529',
};
export const prettyKind = (k: string | null | undefined): string => {
  const key = (k ?? '').toLowerCase();
  return KIND_DISPLAY[key] ?? key.replace(/_/g, ' ').toUpperCase();
};

export const pluralize = (n: number, singular: string, plural = `${singular}s`) =>
  `${n} ${n === 1 ? singular : plural}`;
