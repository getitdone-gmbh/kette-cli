import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { activeBundleLink, bundlesDir, mirror, stateFile } from './paths.mjs';

export async function fetchManifest() {
  const url = `${mirror()}/manifest.json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Manifest not reachable (${res.status}): ${url}`);
  return res.json();
}

const resolveUrl = (u) => (/^https?:\/\//.test(u) ? u : `${mirror()}/${u}`);

// Download error with a reason, so callers can show their own message with the next step
export class DownloadError extends Error {
  constructor(message, { status = null, checksum = false } = {}) {
    super(message);
    this.status = status;
    this.checksum = checksum;
  }
}

export async function download(entry, target) {
  const res = await fetch(resolveUrl(entry.url));
  if (!res.ok) throw new DownloadError(`Download failed (${res.status}): ${entry.url}`, { status: res.status });
  const buf = Buffer.from(await res.arrayBuffer());
  const sum = crypto.createHash('sha256').update(buf).digest('hex');
  if (sum !== entry.sha256) throw new DownloadError(`Checksum does not match for ${entry.url}`, { checksum: true });
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

export function removeState(keys) {
  const state = readState();
  for (const k of keys) delete state[k];
  fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
  fs.writeFileSync(stateFile(), JSON.stringify(state, null, 2) + '\n');
}

// Downloads a bundle, verifies it and unpacks it to ~/.kette/bundles/<tier>/<version>
export async function installEntry(tier, version, entry) {
  const dir = path.join(bundlesDir(), tier, version);
  if (!fs.existsSync(path.join(dir, '.claude-plugin', 'marketplace.json'))) {
    const tgz = await download(entry, path.join(bundlesDir(), `${tier}-${version}.tgz`));
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('tar', ['-xzf', tgz, '-C', dir]);
    fs.rmSync(tgz);
  }
  writeState({ [`bundle_${tier}`]: { version, dir } });
  return dir;
}

export async function installBundle(manifest, tier) {
  const entry = manifest.bundles?.[tier];
  if (!entry) throw new Error(`Bundle ${tier} is missing from the manifest`);
  return installEntry(tier, manifest.version, entry);
}

export function installedBundle(tier) {
  const s = readState()[`bundle_${tier}`];
  return s && fs.existsSync(s.dir) ? s : null;
}

// Fixed path for the Claude Code marketplace, points to the last active bundle (Windows: junction, no admin rights)
export function setActiveBundle(dir) {
  const link = activeBundleLink();
  fs.rmSync(link, { force: true });
  if (!dir) return null;
  fs.symlinkSync(path.resolve(dir), link, 'junction');
  return link;
}
