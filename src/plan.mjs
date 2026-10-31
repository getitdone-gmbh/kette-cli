import fs from 'node:fs';
import path from 'node:path';
import { accent, dim, hint } from './out.mjs';
import { createAtomic, writeAtomic } from './files.mjs';

// A plan is a list of files; existing files are never overwritten, only appended to or renewed in their marked block
// lstat, so a symlink (also a dangling one) counts as present and is never written through
const present = (abs) => { try { return fs.lstatSync(abs); } catch { return null; } };
const inside = (dir, abs) => abs.startsWith(dir + path.sep);
const realOr = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

// Real path of the nearest existing folder, so a symlinked parent folder pointing outside the project is caught before mkdir
function realParent(abs) {
  let dir = path.dirname(abs);
  while (!fs.existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
  return realOr(dir);
}

const kept = (item, note) => ({ ...item, action: 'keep', note });

export function describe(plan, root) {
  const base = path.resolve(root);
  const realRoot = realOr(root);
  return plan.map((item) => {
    const abs = path.resolve(base, item.path);
    if (!inside(base, abs)) return kept(item, 'outside the project, left alone');
    const stat = present(abs);
    if (!stat) return inside(realRoot, realParent(abs)) || realParent(abs) === realRoot ? { ...item, action: 'create' } : kept(item, 'folder links outside the project, left alone');
    if (stat.isSymbolicLink()) return kept(item, fs.existsSync(abs) ? 'symlink, left alone' : 'dangling symlink, left alone');
    if (stat.isDirectory()) return kept(item, 'a folder with this name exists, left alone');
    if (item.mode !== 'append' && item.mode !== 'renew') return kept(item, item.note);
    if (!inside(realRoot, realOr(abs))) return kept(item, 'folder links outside the project, left alone');
    const current = fs.readFileSync(abs, 'utf8');
    if (item.mode === 'append') return { ...item, action: current.includes(item.marker) ? 'keep' : 'append' };
    const next = item.renew(current);
    if (next === null) return { ...item, action: 'keep', unmarked: true };
    return { ...item, action: next === current ? 'keep' : 'update', next };
  });
}

// New files in the accent color, changes as a hint, kept files dimmed
const TAGS = { create: ['+ create ', accent], append: ['~ append ', hint], update: ['~ update ', hint], keep: ['= keep   ', dim] };

export function print(described) {
  for (const d of described) {
    const [tag, style] = TAGS[d.action];
    const name = d.action === 'keep' ? dim(d.path) : d.path;
    console.log(`  ${style(tag)} ${name}${d.note ? dim(`  (${d.note})`) : ''}`);
  }
}

// Refuses the whole plan before writing anything when a path resolves outside the project
export function apply(described, root) {
  const base = path.resolve(root);
  const escaping = described.filter((d) => d.action !== 'keep' && !inside(base, path.resolve(base, d.path)));
  if (escaping.length) throw new Error(`Refusing to write outside the project: ${escaping.map((d) => d.path).join(', ')}`);
  for (const d of described) {
    const abs = path.resolve(base, d.path);
    // Every write is atomic, so a kette killed in the middle leaves the old or the new file, never an empty one
    if (d.action === 'create') {
      createAtomic(abs, d.content);
    } else if (d.action === 'append') {
      const cur = fs.readFileSync(abs, 'utf8');
      writeAtomic(abs, cur.replace(/\n*$/, '\n\n') + d.content);
    } else if (d.action === 'update') {
      writeAtomic(abs, d.next);
    }
  }
}
