import fs from 'node:fs';
import path from 'node:path';

// Ein Plan ist eine Liste von Dateien; vorhandene Dateien werden nie überschrieben
export function describe(plan, root) {
  return plan.map((item) => {
    const abs = path.join(root, item.path);
    const exists = fs.existsSync(abs);
    let action = 'neu';
    if (exists && item.mode === 'append') action = fs.readFileSync(abs, 'utf8').includes(item.marker) ? 'vorhanden' : 'ergänzen';
    else if (exists) action = 'vorhanden';
    return { ...item, action };
  });
}

export function print(described) {
  for (const d of described) {
    const tag = { neu: '+ neu      ', ergänzen: '~ ergänzen ', vorhanden: '= bleibt   ' }[d.action];
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
    }
  }
}
