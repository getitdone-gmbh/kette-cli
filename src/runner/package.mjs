// The workload.zero runner package: from the Enterprise bundle (runner/manifest.json) or a local tgz, checked by SHA-256 and unpacked to ~/.kette/runner/<version> (docs/adr/0004)
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ExitError } from '../errors.mjs';
import { withLock, sweepDead } from '../lock.mjs';
import { validVersion } from '../manifest.mjs';
import { bundlesDir, home } from '../paths.mjs';

export const PART = 'runner';
export const ROOT = 'zero-agent-runner';
export const DEFAULT_ENTRY = `${ROOT}/dist/bin.js`;
const FILE_NAME = /^[0-9A-Za-z][0-9A-Za-z._+-]*\.tgz$/;
const ENTRY = /^zero-agent-runner\/[0-9A-Za-z._/-]+\.js$/;

export const runnerDir = () => path.join(home(), 'runner');
export const currentLink = () => path.join(runnerDir(), 'current');
// The entry the service starts goes through current, so an update only moves the link
export const currentEntry = (entry = DEFAULT_ENTRY) => path.join(currentLink(), entry);

const inside = (dir, f) => { const rel = path.relative(dir, f); return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel); };
const sha256Of = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// The runner of a bundle, null when the bundle has none or when the folder or file does not really lie inside the bundles folder (like ticketing, KETTE-28)
export function packageFromBundle(bundle, { root = bundlesDir() } = {}) {
  if (!bundle?.dir) return null;
  const dir = path.join(bundle.dir, PART);
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); } catch { return null; }
  if (!manifest || typeof manifest.file !== 'string' || !FILE_NAME.test(manifest.file) || !/^[0-9a-f]{64}$/.test(manifest.sha256 || '')) return null;
  let real;
  let realRoot;
  try { realRoot = fs.realpathSync(root); real = fs.realpathSync(path.join(dir, manifest.file)); } catch { return null; }
  if (!inside(realRoot, real)) return null;
  return { file: real, sha256: manifest.sha256, version: manifest.version, node: manifest.node, entry: ENTRY.test(manifest.entry || '') ? manifest.entry : DEFAULT_ENTRY };
}

export function packageFromFile(from, sha256) {
  if (from && !sha256) throw new ExitError('--from needs --sha256 <hex> of the package (zero-agent-runner-<version>.tgz.sha256).', 2);
  if (sha256 && !from) throw new ExitError('--sha256 only with --from <tgz>.', 2);
  if (!/^[0-9a-f]{64}$/i.test(sha256)) throw new ExitError('--sha256 must be 64 hex characters.', 2);
  const file = path.resolve(from);
  if (!fs.existsSync(file)) throw new ExitError(`${file} not found.`, 1);
  return { file, sha256: sha256.toLowerCase(), version: null, node: null, entry: DEFAULT_ENTRY };
}

// The lowest major Node a manifest asks for (">=22"); unknown forms count as 22
export const minNode = (range) => Number(/(\d+)/.exec(String(range || ''))?.[1] || 22);

// Verifies and unpacks; nothing is left behind when a check fails. Returns { version, dir, entry } of ~/.kette/runner/<version>
export function installPackage(source) {
  const actual = sha256Of(source.file);
  if (actual !== source.sha256) throw new ExitError(`Checksum does not match for ${path.basename(source.file)}, nothing was installed.`, 1);
  fs.mkdirSync(runnerDir(), { recursive: true });
  sweepDead(runnerDir(), /^\.unpack\.(\d+)\.[0-9a-f]+$/);
  const temp = path.join(runnerDir(), `.unpack.${process.pid}.${crypto.randomBytes(4).toString('hex')}`);
  try {
    fs.mkdirSync(temp, { recursive: true });
    execFileSync('tar', ['-xzf', source.file, '-C', temp], { stdio: ['ignore', 'ignore', 'pipe'] });
    let version;
    try { ({ version } = JSON.parse(fs.readFileSync(path.join(temp, ROOT, 'package.json'), 'utf8'))); } catch { version = null; }
    if (!validVersion(version)) throw new ExitError(`The runner package has no valid version in ${ROOT}/package.json, nothing was installed.`, 1);
    if (source.version && source.version !== version) throw new ExitError(`The bundle names runner ${source.version}, the package is ${version}; nothing was installed. Run kette update.`, 1);
    const entry = source.entry || DEFAULT_ENTRY;
    if (!fs.existsSync(path.join(temp, entry))) throw new ExitError(`The runner package misses ${entry}, nothing was installed.`, 1);
    const dir = path.join(runnerDir(), version);
    withLock(`runner-${version}`, () => {
      if (fs.existsSync(path.join(dir, entry))) return;
      fs.rmSync(dir, { recursive: true, force: true });
      fs.renameSync(temp, dir);
    });
    return { version, dir, entry };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

// The version current points to, null without one
export function currentVersion() {
  try { return fs.readlinkSync(currentLink()); } catch { return null; }
}

// Moves current atomically: a new link next to it, then rename over the old one
export function setCurrent(version) {
  const tmpLink = path.join(runnerDir(), `.current.${process.pid}`);
  fs.rmSync(tmpLink, { force: true });
  fs.symlinkSync(version, tmpLink);
  fs.renameSync(tmpLink, currentLink());
}

export function removePackages() {
  fs.rmSync(runnerDir(), { recursive: true, force: true });
}
