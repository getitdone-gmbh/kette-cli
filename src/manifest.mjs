import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { bundlesDir, mirror, stateFile } from './paths.mjs';

export async function fetchManifest() {
  const url = `${mirror()}/manifest.json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Manifest nicht erreichbar (${res.status}): ${url}`);
  return res.json();
}

const resolveUrl = (u) => (/^https?:\/\//.test(u) ? u : `${mirror()}/${u}`);

export async function download(entry, target) {
  const res = await fetch(resolveUrl(entry.url));
  if (!res.ok) throw new Error(`Download fehlgeschlagen (${res.status}): ${entry.url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const sum = crypto.createHash('sha256').update(buf).digest('hex');
  if (sum !== entry.sha256) throw new Error(`Prüfsumme stimmt nicht für ${entry.url}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, buf);
  return target;
}

export function readState() {
  try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch { return {}; }
}

export function writeState(next) {
  fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
  fs.writeFileSync(stateFile(), JSON.stringify({ ...readState(), ...next }, null, 2) + '\n');
}

// Lädt ein Regelwerk-Paket, prüft es und entpackt es nach ~/.kette/bundles/<tier>/<version>
export async function installBundle(manifest, tier) {
  const entry = manifest.bundles?.[tier];
  if (!entry) throw new Error(`Paket ${tier} ist im Manifest nicht vorhanden`);
  const dir = path.join(bundlesDir(), tier, manifest.version);
  if (fs.existsSync(path.join(dir, '.claude-plugin', 'marketplace.json'))) return dir;
  const tgz = await download(entry, path.join(bundlesDir(), `${tier}-${manifest.version}.tgz`));
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('tar', ['-xzf', tgz, '-C', dir]);
  fs.rmSync(tgz);
  writeState({ [`bundle_${tier}`]: { version: manifest.version, dir } });
  return dir;
}

export function installedBundle(tier) {
  const s = readState()[`bundle_${tier}`];
  return s && fs.existsSync(s.dir) ? s : null;
}
