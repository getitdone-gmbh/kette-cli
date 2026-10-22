// Single seam for terminal styling; identity for now, colors follow once the brand palette is approved
export const cmd = (s) => s;
export const file = (s) => s;
// kind is ok, fail, warn or info; text is already padded so styling never shifts columns
export const status = (kind, text) => text;
export const bold = (s) => (process.stdout.isTTY && !process.env.NO_COLOR ? `\x1b[1m${s}\x1b[22m` : s);

// Unambiguous YYYY-MM-DD in UTC; fallback when the value is missing or not a date
export function isoDate(iso, fallback) {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : fallback;
}
