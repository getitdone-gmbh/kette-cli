import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isInside } from './files.mjs';

// What kette wrote for Enterprise into a project, so it can be removed when the project joins a Community instance (docs/adr/0002, decision 9):
// the template files it created with the hash they had, and the exact scope line it put into the project .npmrc
export const RECORD_PATH = '.kette/templates.json';
const NPMRC = '.npmrc';
const hash = (text) => crypto.createHash('sha256').update(text).digest('hex');

function readRecord(root) {
  try {
    const r = JSON.parse(fs.readFileSync(path.join(root, RECORD_PATH), 'utf8'));
    const files = r && typeof r.files === 'object' && !Array.isArray(r.files) ? r.files : {};
    return { version: 1, files, ...(typeof r?.npmrc === 'string' ? { npmrc: r.npmrc } : {}) };
  } catch {
    return { version: 1, files: {} };
  }
}

function writeRecord(root, record) {
  const f = path.join(root, RECORD_PATH);
  if (!Object.keys(record.files).length && !record.npmrc) { fs.rmSync(f, { force: true }); return; }
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const next = { version: 1, files: Object.fromEntries(Object.entries(record.files).sort()), ...(record.npmrc ? { npmrc: record.npmrc } : {}) };
  fs.writeFileSync(f, `${JSON.stringify(next, null, 2)}\n`);
}

// After a plan was applied: every template file kette created with its content hash, and the scope line it added to .npmrc
export function recordTemplates(root, described) {
  const created = described.filter((d) => d.template && d.action === 'create');
  const npmrc = described.find((d) => d.npmrc && (d.action === 'create' || d.action === 'append'));
  if (!created.length && !npmrc) return;
  const record = readRecord(root);
  for (const d of created) record.files[d.path] = hash(d.content);
  if (npmrc) record.npmrc = npmrc.content.trim();
  writeRecord(root, record);
}

// The real path of a project file, only when it stays inside the real project folder (a symlinked folder pointing outside never counts)
function ownFile(root, p) {
  const base = fs.realpathSync(root);
  const abs = path.resolve(base, p);
  if (!isInside(base, abs) || abs === base) return null;
  let real;
  try { real = fs.realpathSync(abs); } catch { return null; }
  return isInside(base, real) && real !== base && fs.statSync(real).isFile() ? real : null;
}

// The line kette would remove: the one it recorded, or for projects from before the record the line with the kette registry
const scopeLines = (record, ketteLine) => [record.npmrc, ketteLine].filter(Boolean);

// unchanged: kette may delete it; changed: someone edited it, it stays and doctor names it; npmrc: the kette scope line is there
export function enterpriseLeftovers(root, ketteLine = null) {
  const record = readRecord(root);
  const files = Object.entries(record.files).map(([p, sum]) => {
    const real = ownFile(root, p);
    return real ? { path: p, changed: hash(fs.readFileSync(real, 'utf8')) !== sum } : null;
  }).filter(Boolean);
  const npmrcFile = ownFile(root, NPMRC);
  const wanted = scopeLines(record, ketteLine);
  const npmrc = Boolean(npmrcFile) && fs.readFileSync(npmrcFile, 'utf8').split(/\r?\n/).some((l) => wanted.includes(l.trim()));
  return { files, npmrc };
}

// Removes empty folders up to the project folder, so a removed workflow does not leave .github/workflows behind
function prune(base, dir) {
  while (isInside(base, dir) && dir !== base && fs.existsSync(dir) && !fs.readdirSync(dir).length) {
    fs.rmdirSync(dir);
    dir = path.dirname(dir);
  }
}

// Deletes unchanged template files and only the exact kette scope line (line endings and every other line stay);
// changed files stay recorded, so doctor keeps failing until someone decides
export function removeLeftovers(root, ketteLine = null) {
  const base = fs.realpathSync(root);
  const record = readRecord(root);
  const { files, npmrc } = enterpriseLeftovers(root, ketteLine);
  const removed = [];
  for (const f of files.filter((x) => !x.changed)) {
    const real = ownFile(root, f.path);
    if (!real) continue;
    fs.rmSync(real);
    delete record.files[f.path];
    prune(base, path.dirname(real));
    removed.push(f.path);
  }
  for (const p of Object.keys(record.files)) if (!ownFile(root, p)) delete record.files[p];
  if (npmrc) {
    const f = ownFile(root, NPMRC);
    const text = fs.readFileSync(f, 'utf8');
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const wanted = scopeLines(record, ketteLine);
    const rest = text.split(/\r?\n/).filter((l) => !wanted.includes(l.trim()));
    while (rest.length && rest.at(-1) === '') rest.pop();
    if (rest.length) fs.writeFileSync(f, rest.join(eol) + eol); else fs.rmSync(f);
    removed.push(`${NPMRC} (the scope line kette wrote)`);
  }
  delete record.npmrc;
  writeRecord(root, record);
  return { removed, kept: files.filter((x) => x.changed).map((x) => x.path) };
}
