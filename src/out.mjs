// Terminal styling of Die Kette by role, zero dependencies; plain text when color is off (pipes, CI, NO_COLOR)
// Meaning always sits in the word (OK, INFO, WARN, FAIL), never in the color alone; background colors are never set
const PALETTES = {
  dark: { accent: ['#4ff0c6', 86], hint: ['#ff9a55', 209], error: ['#ff6b6b', 203], dim: ['#8794a0', 246] },
  light: { accent: ['#007a63', 29], hint: ['#b4530f', 130], error: ['#c4262e', 160], dim: ['#66727d', 243] },
};
const ESC = '\x1b[';
const wrap = (open, close) => (s) => `${ESC}${open}m${s}${ESC}${close}m`;
// Unknown background: the 16 theme colors, which every terminal theme tunes to its own background
const BASIC = { accent: wrap('32', '39'), hint: wrap('1', '22'), error: wrap('1;31', '22;39'), dim: wrap('2', '22') };
const SYMBOLS = { dot: '●', sep: '·', tee: '├', end: '└', bar: '│' };
const ASCII = { dot: '*', sep: '-', tee: '|-', end: '`-', bar: '|' };

// 0 plain, 1 sixteen colors, 2 256 colors, 3 truecolor; flag is --color (true) or --no-color (false)
export function colorLevel(env = process.env, { flag, ci = false, isTTY = process.stdout.isTTY } = {}) {
  if (flag === false || (env.NO_COLOR && flag !== true)) return 0;
  const forced = env.FORCE_COLOR;
  if (forced !== undefined && flag !== true) return forced === 'false' ? 0 : Math.min(3, /^\d$/.test(forced) ? Number(forced) : 1);
  if (flag !== true && (!isTTY || env.CI || env.TERM === 'dumb' || ci)) return 0;
  if (/^(truecolor|24bit)$/i.test(env.COLORTERM || '') || env.WT_SESSION || ['iTerm.app', 'vscode'].includes(env.TERM_PROGRAM)) return 3;
  return /256color/.test(env.TERM || '') ? 2 : 1;
}

// dark, light or null: KETTE_THEME, then COLORFGBG (background 7 and 9 to 15 are light); no terminal query
export function backgroundTheme(env = process.env) {
  if (['dark', 'light'].includes(env.KETTE_THEME)) return env.KETTE_THEME;
  const bg = (env.COLORFGBG || '').split(';').pop();
  if (!/^\d+$/.test(bg)) return null;
  return Number(bg) === 7 || Number(bg) >= 9 ? 'light' : 'dark';
}

function roleStyle(role, level, palette) {
  if (!palette || level < 2) return BASIC[role];
  const [hex, code] = palette[role];
  const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(';');
  return wrap(level === 3 ? `38;2;${rgb}` : `38;5;${code}`, '39');
}

let current = null;

// Called once per command with the parsed flags; until then the environment alone decides. stdout and stderr each get their own
// decision, so 2>err.log stays plain while the terminal shows colors
export function configure({ color, ci = false } = {}, env = process.env, tty = { out: process.stdout.isTTY, err: process.stderr.isTTY }) {
  const palette = PALETTES[backgroundTheme(env)] || null;
  const stylesFor = (isTTY) => {
    const level = colorLevel(env, { flag: color, ci, isTTY });
    return level ? Object.fromEntries(Object.keys(BASIC).map((role) => [role, roleStyle(role, level, palette)])) : null;
  };
  const unicode = process.platform !== 'win32' || Boolean(env.WT_SESSION) || env.TERM_PROGRAM === 'vscode';
  current = { out: stylesFor(tty.out), err: stylesFor(tty.err), symbols: unicode ? SYMBOLS : ASCII };
}
const state = () => current || (configure(), current);

// Role helpers for one stream; stdout is the default export, toStderr styles text for console.error
function roles(stream) {
  const role = (name) => (s) => (state()[stream] ? state()[stream][name](s) : s);
  const accent = role('accent');
  const hint = role('hint');
  const error = role('error');
  const dim = role('dim');
  const bold = (s) => (state()[stream] ? wrap('1', '22')(s) : s);
  return {
    accent, hint, error, dim, bold,
    cmd: accent,
    num: (n) => bold(accent(String(n))),
    // kind is ok, fail, warn or info; text is already padded so styling never shifts columns
    status: (kind, text) => bold({ ok: accent, fail: error, warn: hint, info: dim }[kind](text)),
  };
}

export const { accent, hint, error, dim, bold, cmd, num, status } = roles('out');
export const toStderr = roles('err');
export const symbols = () => state().symbols;
// Escape codes around what the user types, so the answer stands out from the question
export const inputStyle = () => (state().out ? [`${ESC}1m`, `${ESC}22m`] : ['', '']);
// Paths keep the default text color, the strongest contrast in every theme
export const file = (s) => s;
export const brandLine = (detail) => `${bold(accent(`${symbols().dot} DIE KETTE`))}  ${dim(detail)}`;

// Unambiguous YYYY-MM-DD in UTC; fallback when the value is missing or not a date
export function isoDate(iso, fallback) {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : fallback;
}
