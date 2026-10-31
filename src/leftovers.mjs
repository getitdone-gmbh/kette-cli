import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SCOPE } from './npmrc.mjs';

// What kette wrote for Enterprise into a project, so it can be removed when the project joins a Community instance (docs/adr/0002, decision 9):
// the template files it created, with the hash they had, and the scope line in the project .npmrc
export const RECORD_PATH = '.kette/templates.json';
const NPMRC = '.npmrc';
const SCOPE_LINE = new RegExp(`^${SCOPE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:registry=.*$`, 'm');
const hash = (text) => crypto.createHash('sha256').update(text).digest('hex');

function readRecord(root) {
  try {
    const r = JSON.parse(fs.readFileSync(path.join(root, RECORD_PATH), 'utf8'));
    return r && typeof r.files === 'object' && !Array.isArray(r.files) ? r : { version: 1, files: {} };
  } catch {
    return { version: 1, files: {} };
  }
}

function writeRecord(root, record) {
  const f = path.join(root, RECORD_PATH);
  if (!Object.keys(record.files).length) { fs.rmSync(f, { force: true }); return; }
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, `${JSON.stringify({ version: 1, files: Object.fromEntries(Object.entries(record.files).sort()) }, null, 2)}\n`);
}

// After a plan was applied: every template file kette created, with its content hash
export function recordTemplates(root, described) {
  const created = described.filter((d) => d.template && d.action === 'create');
  if (!created.length) return;
  const record = readRecord(root);
  for (const d of created) record.files[d.path] = hash(d.content);
  writeRecord(root, record);
}

const inside = (root, abs) => { const rel = path.relative(root, abs); return rel && !rel.startsWith('..') && !path.isAbsolute(rel); };

// unchanged: kette may delete it; changed: someone edited it, it stays and doctor names it
export function enterpriseLeftovers(root) {
  const base = path.resolve(root);
  const files = Object.entries(readRecord(root).files).filter(([p]) => inside(base, path.resolve(base, p))).map(([p, sum]) => {
    const abs = path.resolve(base, p);
    if (!fs.existsSync(abs)) return null;
    return { path: p, changed: hash(fs.readFileSync(abs, 'utf8')) !== sum };
  }).filter(Boolean);
  const npmrc = path.join(base, NPMRC);
  return { files, npmrc: fs.existsSync(npmrc) && SCOPE_LINE.test(fs.readFileSync(npmrc, 'utf8')) };
}

// Removes empty folders up to the project folder, so a removed workflow does not leave .github/workflows behind
function prune(base, dir) {
  while (inside(base, dir) && fs.existsSync(dir) && !fs.readdirSync(dir).length) {
    fs.rmdirSync(dir);
    dir = path.dirname(dir);
  }
}

// Deletes unchanged template files and the scope line; changed files stay recorded, so doctor keeps failing until someone decides
export function removeLeftovers(root) {
  const base = path.resolve(root);
  const { files, npmrc } = enterpriseLeftovers(root);
  const record = readRecord(root);
  const removed = [];
  for (const f of files.filter((x) => !x.changed)) {
    const abs = path.resolve(base, f.path);
    fs.rmSync(abs);
    delete record.files[f.path];
    prune(base, path.dirname(abs));
    removed.push(f.path);
  }
  for (const p of Object.keys(record.files)) if (!fs.existsSync(path.resolve(base, p))) delete record.files[p];
  writeRecord(root, record);
  if (npmrc) {
    const f = path.join(base, NPMRC);
    const rest = fs.readFileSync(f, 'utf8').split(/\r?\n/).filter((l) => !SCOPE_LINE.test(l)).join('\n').trim();
    if (rest) fs.writeFileSync(f, `${rest}\n`); else fs.rmSync(f);
    removed.push(`${NPMRC} (scope line ${SCOPE})`);
  }
  return { removed, kept: files.filter((x) => x.changed).map((x) => x.path) };
}
