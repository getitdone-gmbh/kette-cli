import fs from 'node:fs';
import path from 'node:path';

// Ein Plan ist eine Liste von Dateien; vorhandene Dateien werden nie überschrieben, nur ergänzt (append) oder in ihrem markierten Block erneuert (renew)
export function describe(plan, root) {
  return plan.map((item) => {
    const abs = path.join(root, item.path);
    if (!fs.existsSync(abs)) return { ...item, action: 'neu' };
    const current = fs.readFileSync(abs, 'utf8');
    if (item.mode === 'append') return { ...item, action: current.includes(item.marker) ? 'vorhanden' : 'ergänzen' };
    if (item.mode === 'renew') {
      const next = item.renew(current);
      if (next === null) return { ...item, action: 'vorhanden', unmarked: true };
      return { ...item, action: next === current ? 'vorhanden' : 'erneuern', next };
    }
    return { ...item, action: 'vorhanden' };
  });
}

export function print(described) {
  for (const d of described) {
    const tag = { neu: '+ neu      ', ergänzen: '~ ergänzen ', erneuern: '~ erneuern ', vorhanden: '= bleibt   ' }[d.action];
    console.log(`  ${tag} ${d.path}${d.note ? `  (${d.note})` : ''}`);
  }
}

export function apply(described, root) {
  for (const d of described) {
    const abs = path.join(root, d.path);
    if (d.action === 'neu') {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, d.content);
    } else if (d.action === 'ergänzen') {
      const cur = fs.readFileSync(abs, 'utf8');
      fs.writeFileSync(abs, cur.replace(/\n*$/, '\n\n') + d.content);
    } else if (d.action === 'erneuern') {
      fs.writeFileSync(abs, d.next);
    }
  }
}
