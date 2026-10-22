import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { activeBundleLink, bundlesDir, isSecureUrl, mirror, stateFile } from './paths.mjs';
import { writePrivate } from './files.mjs';
import { cmd, status } from './out.mjs';

export async function fetchManifest() {
  const url = `${mirror()}/manifest.json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Manifest not reachable (${res.status}): ${url}`);
  return res.json();
}

// A version becomes a folder name under ~/.kette that gets replaced, so only plain names
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/;
export const validVersion = (v) => typeof v === 'string' && VERSION_PATTERN.test(v) && !v.includes('..');
const FILE_NAME = /^[0-9A-Za-z][0-9A-Za-z._+-]*$/;

// A file name on the mirror or an https URL; anyHost for signed links of the delivery service, otherwise only the mirror host
function resolveUrl(u, anyHost) {
  if (typeof u !== 'string') return null;
  if (FILE_NAME.test(u)) return u.includes('..') ? null : `${mirror()}/${u}`;
  if (!isSecureUrl(u)) return null;
  return anyHost || new URL(u).host === new URL(mirror()).host ? u : null;
}

// Download error with a reason, so callers can show their own message with the next step
export class DownloadError extends Error {
  constructor(message, { status = null, checksum = false } = {}) {
    super(message);
    this.status = status;
    this.checksum = checksum;
  }
}

export async function download(entry, target, { anyHost = false } = {}) {
  const url = resolveUrl(entry.url, anyHost);
  if (!url) throw new DownloadError(`Invalid download URL ${JSON.stringify(entry.url)}, nothing was installed`);
  const res = await fetch(url);
  if (!res.ok) throw new DownloadError(`Download failed (${res.status}): ${entry.url}`, { status: res.status });
  const buf = Buffer.from(await res.arrayBuffer());
  const sum = crypto.createHash('sha256').update(buf).digest('hex');
  if (sum !== entry.sha256) throw new DownloadError(`Checksum does not match for ${entry.url}`, { checksum: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, buf);
  return target;
}

// Missing file is an empty state; a damaged one is moved to state.json.bak with a warning, so nothing is lost silently
export function readState() {
  const file = stateFile();
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    let moved = true;
    try { fs.renameSync(file, `${file}.bak`); } catch { moved = false; }
    console.error(`${status('warn', 'WARN')} ${file} is not readable (${err.message}). ${moved ? `Moved to ${file}.bak, ` : ''}kette starts with an empty state; ${cmd('kette update')} loads the rulebook again.`);
    return {};
  }
}

const saveState = (state) => writePrivate(stateFile(), JSON.stringify(state, null, 2) + '\n');

export function writeState(next) {
  saveState({ ...readState(), ...next });
}

export function removeState(keys) {
  const state = readState();
  for (const k of keys) delete state[k];
  saveState(state);
}

// Downloads a bundle, verifies it and unpacks it to ~/.kette/bundles/<tier>/<version>
export async function installEntry(tier, version, entry, { anyHost = false } = {}) {
  if (!validVersion(version)) throw new Error(`Invalid bundle version ${JSON.stringify(version)}, nothing was installed`);
  const dir = path.join(bundlesDir(), tier, version);
  if (!fs.existsSync(path.join(dir, '.claude-plugin', 'marketplace.json'))) {
    const tgz = await download(entry, path.join(bundlesDir(), `${tier}-${version}.tgz`), { anyHost });
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
