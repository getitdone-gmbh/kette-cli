import fs from 'node:fs';
import path from 'node:path';
import { accent, dim, hint } from './out.mjs';

// A plan is a list of files; existing files are never overwritten, only appended to or renewed in their marked block
// lstat, so a dangling symlink counts as present and is never written through
const present = (abs) => { try { return fs.lstatSync(abs); } catch { return null; } };

export function describe(plan, root) {
  return plan.map((item) => {
    const abs = path.join(root, item.path);
    const stat = present(abs);
    if (!stat) return { ...item, action: 'create' };
    if (stat.isSymbolicLink() && !fs.existsSync(abs)) return { ...item, action: 'keep', note: 'dangling symlink, left alone' };
    const current = fs.readFileSync(abs, 'utf8');
    if (item.mode === 'append') return { ...item, action: current.includes(item.marker) ? 'keep' : 'append' };
    if (item.mode === 'renew') {
      const next = item.renew(current);
      if (next === null) return { ...item, action: 'keep', unmarked: true };
      return { ...item, action: next === current ? 'keep' : 'update', next };
    }
    return { ...item, action: 'keep' };
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

export function apply(described, root) {
  for (const d of described) {
    const abs = path.join(root, d.path);
    if (d.action === 'create') {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, d.content, { flag: 'wx' });
    } else if (d.action === 'append') {
      const cur = fs.readFileSync(abs, 'utf8');
      fs.writeFileSync(abs, cur.replace(/\n*$/, '\n\n') + d.content);
    } else if (d.action === 'update') {
      fs.writeFileSync(abs, d.next);
    }
  }
}
