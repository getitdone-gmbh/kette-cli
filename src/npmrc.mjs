import fs from 'node:fs';

// Marked block in the user npmrc: kette login writes it, kette logout removes only it
export const SCOPE = '@getitdone-gmbh';
export const BLOCK_START = '# >>> kette: managed by kette login, removed by kette logout';
export const BLOCK_END = '# <<< kette';
// Foreign scope lines that kette login --npm-replace commented out; kette logout restores them, also with the German prefix up to 0.5
const DISABLED = '# disabled by kette login: ';
const DISABLED_PREFIXES = [DISABLED, '# kette login hat deaktiviert: '];
const SCOPE_LINE = new RegExp(`^\\s*${SCOPE}:registry\\s*=\\s*(\\S+)\\s*$`);
export const TOKEN_PATTERN = /kt_[A-Za-z0-9_-]{43}/;

const eolOf = (content) => (content.includes('\r\n') ? '\r\n' : '\n');
const linesOf = (content) => (content ? content.split(/\r?\n/) : []);

// //host/path/ without protocol, the way npm maps a token to a registry
export const authKey = (registry) => registry.replace(/^https?:/, '').replace(/\/?$/, '/');

// Only the token is global, per device; the scope line lives in the project .npmrc of Enterprise projects (docs/adr/0002, D3),
// so npm in a Community repo never resolves the design system packages from the Enterprise registry
export function blockLines(registry, token) {
  return [BLOCK_START, `${authKey(registry)}:_authToken=${token}`, BLOCK_END];
}

// Lines outside the block and the block itself (null when missing)
function split(content) {
  const lines = linesOf(content);
  const start = lines.indexOf(BLOCK_START);
  const end = start === -1 ? -1 : lines.indexOf(BLOCK_END, start);
  if (start === -1 || end === -1) return { outside: lines, block: null };
  return { outside: [...lines.slice(0, start), ...lines.slice(end + 1)], block: lines.slice(start + 1, end) };
}

const join = (lines, eol) => {
  const trimmed = [...lines];
  while (trimmed.length && trimmed.at(-1) === '') trimmed.pop();
  return trimmed.length ? trimmed.join(eol) + eol : '';
};

// Scope lines outside the block, e.g. a developer using npm.pkg.github.com
export function foreignScopeLines(content) {
  return split(content).outside.filter((l) => SCOPE_LINE.test(l));
}

export function blockToken(content) {
  const { block } = split(content);
  return block?.map((l) => l.match(TOKEN_PATTERN)?.[0]).find(Boolean) || null;
}

export function hasBlock(content) {
  return split(content).block !== null;
}

// A block written before 0.10 still holds the scope line; kette login and kette update write it again without
export const blockHasScope = (content) => (split(content).block || []).some((l) => SCOPE_LINE.test(l));

// New content with the renewed block at the end; replace comments out foreign scope lines
export function withBlock(content, registry, token, { replace = false } = {}) {
  const eol = eolOf(content);
  const outside = split(content).outside.map((l) => (replace && SCOPE_LINE.test(l) ? DISABLED + l : l));
  const head = join(outside, eol);
  return `${head}${head ? eol : ''}${blockLines(registry, token).join(eol)}${eol}`;
}

// Content without the block, commented-out lines active again
export function withoutBlock(content) {
  const eol = eolOf(content);
  return join(split(content).outside.map((l) => {
    const prefix = DISABLED_PREFIXES.find((p) => l.startsWith(p));
    return prefix ? l.slice(prefix.length) : l;
  }), eol);
}

export function readFile(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

// Registry the scope points to in a project .npmrc, null without a scope line
export function projectScope(content) {
  return linesOf(content).map((l) => l.match(SCOPE_LINE)?.[1]).find(Boolean) || null;
}
