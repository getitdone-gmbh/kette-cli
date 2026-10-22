import fs from 'node:fs';
import path from 'node:path';

// Markierter Block in der Benutzer-npmrc: kette login schreibt ihn, kette logout entfernt nur ihn
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

// //host/pfad/ ohne Protokoll, so wie npm den Token einer Registry zuordnet
export const authKey = (registry) => registry.replace(/^https?:/, '').replace(/\/?$/, '/');

export function blockLines(registry, token) {
  return [BLOCK_START, `${SCOPE}:registry=${registry}`, `${authKey(registry)}:_authToken=${token}`, BLOCK_END];
}

// Zeilen außerhalb des Blocks und der Block selbst (null, wenn er fehlt)
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

// Scope-Zeilen außerhalb des Blocks, z. B. ein Entwickler mit npm.pkg.github.com
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

// Neuer Inhalt mit erneuertem Block am Ende; replace kommentiert fremde Scope-Zeilen aus
export function withBlock(content, registry, token, { replace = false } = {}) {
  const eol = eolOf(content);
  const outside = split(content).outside.map((l) => (replace && SCOPE_LINE.test(l) ? DISABLED + l : l));
  const head = join(outside, eol);
  return `${head}${head ? eol : ''}${blockLines(registry, token).join(eol)}${eol}`;
}

// Inhalt ohne Block, auskommentierte Zeilen wieder aktiv
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

// Rechte 600, auch für eine schon vorhandene Datei
export function writePrivate(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

// Registry, auf die der Scope in einer Projekt-.npmrc zeigt, null ohne Scope-Zeile
export function projectScope(content) {
  return linesOf(content).map((l) => l.match(SCOPE_LINE)?.[1]).find(Boolean) || null;
}
