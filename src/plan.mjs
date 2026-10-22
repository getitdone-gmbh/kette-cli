import fs from 'node:fs';
import path from 'node:path';

// Ein Plan ist eine Liste von Dateien; vorhandene Dateien werden nie überschrieben, nur ergänzt (append) oder in ihrem markierten Block erneuert (renew)
export function describe(plan, root) {
  return plan.map((item) => {
    const abs = path.join(root, item.path);
    if (!fs.existsSync(abs)) return { ...item, action: 'create' };
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

export function print(described) {
  for (const d of described) {
    const tag = { create: '+ create ', append: '~ append ', update: '~ update ', keep: '= keep   ' }[d.action];
    console.log(`  ${tag} ${d.path}${d.note ? `  (${d.note})` : ''}`);
  }
}

export function apply(described, root) {
  for (const d of described) {
    const abs = path.join(root, d.path);
    if (d.action === 'create') {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, d.content);
    } else if (d.action === 'append') {
      const cur = fs.readFileSync(abs, 'utf8');
      fs.writeFileSync(abs, cur.replace(/\n*$/, '\n\n') + d.content);
    } else if (d.action === 'update') {
      fs.writeFileSync(abs, d.next);
    }
  }
}
