// The part runner/ of the Enterprise bundle: the zero-agent-runner package and runner/manifest.json, checked like ticketing (docs/adr/0004)
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { forbiddenIn } from './ticketing-part.mjs';

export const RUNNER_PART = 'runner';
const FILE_NAME = /^[0-9A-Za-z][0-9A-Za-z._+-]*\.tgz$/;
const VERSION = /^\d+\.\d+\.\d+$/;
// Third-party packages are not ours to filter (licence texts, sample addresses); the own code, README and vendored zero-wallet are
const SKIP = new Set(['node_modules']);

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

// Copies everything except node_modules into a scan folder, then the word filters of ticketing; findings as "path: what"
export function runnerForbidden(unpacked, opts = {}) {
  const scan = fs.mkdtempSync(path.join(path.dirname(unpacked), `.${path.basename(unpacked)}-scan-`));
  try {
    fs.cpSync(unpacked, scan, { recursive: true, filter: (src) => !SKIP.has(path.basename(src)) });
    return forbiddenIn(scan, opts);
  } finally {
    fs.rmSync(scan, { recursive: true, force: true });
  }
}
