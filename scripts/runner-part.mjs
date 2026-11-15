// The part runner/ of the Enterprise bundle: the zero-agent-runner package and runner/manifest.json, checked like ticketing (docs/adr/0004)
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { forbiddenIn } from './ticketing-part.mjs';

export const RUNNER_PART = 'runner';
const FILE_NAME = /^[0-9A-Za-z][0-9A-Za-z._+-]*\.tgz$/;
const VERSION = /^\d+\.\d+\.\d+$/;
// Third-party packages are not ours to filter (licence texts, sample addresses); the own code, the README and the bundled
// zero-wallet are, also where it sits in node_modules (SEC768-05)
const OWN_PACKAGES = new Set(['zero-wallet']);

// Keeps a path unless it lies in node_modules outside an own package; scope folders are kept so their own packages are reached
export function scanned(rel) {
  const parts = rel.split(/[\\/]/).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] !== 'node_modules') continue;
    const next = parts[i + 1];
    if (next === undefined) return true;
    if (OWN_PACKAGES.has(next)) { i += 1; continue; }
    if (next.startsWith('@')) {
      const pkg = parts[i + 2];
      if (pkg === undefined) return true;
      if (OWN_PACKAGES.has(pkg)) { i += 2; continue; }
    }
    return false;
  }
  return true;
}

// Copies the tgz into dest/runner/ and writes runner/manifest.json; a wrong checksum, file name or version stops the release
export function stageRunnerPart(tgz, meta, dest) {
  if (typeof meta.file !== 'string' || !FILE_NAME.test(meta.file)) throw new Error(`zero-agent-runner manifest has an invalid file name ${JSON.stringify(meta.file)}, nothing was packed`);
  if (!VERSION.test(meta.version || '')) throw new Error(`zero-agent-runner manifest has an invalid version ${JSON.stringify(meta.version)}, nothing was packed`);
  const sum = crypto.createHash('sha256').update(fs.readFileSync(tgz)).digest('hex');
  if (sum !== meta.sha256) throw new Error(`zero-agent-runner ${meta.version}: checksum of ${path.basename(tgz)} does not match its manifest, nothing was packed`);
  const manifest = { version: meta.version, file: meta.file, sha256: sum, node: meta.node || '>=22', entry: meta.entry || 'zero-agent-runner/dist/bin.js', protocol: meta.protocol || '1', platforms: meta.platforms || ['linux', 'darwin'] };
  const dir = path.join(dest, RUNNER_PART);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(tgz, path.join(dir, meta.file));
  fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

// Copies everything but third-party node_modules into a scan folder, then the word filters of ticketing; findings as "path: what"
export function runnerForbidden(unpacked, opts = {}) {
  const scan = fs.mkdtempSync(path.join(path.dirname(unpacked), `.${path.basename(unpacked)}-scan-`));
  try {
    fs.cpSync(unpacked, scan, { recursive: true, filter: (src) => scanned(path.relative(unpacked, src)) });
    return forbiddenIn(scan, opts);
  } finally {
    fs.rmSync(scan, { recursive: true, force: true });
  }
}
