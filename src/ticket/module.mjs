import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ExitError } from '../errors.mjs';
import { cmd } from '../out.mjs';
import { bundlesDir } from '../paths.mjs';

// The ticketing library is Enterprise and never part of this public package: it ships in the Enterprise bundle (docs/adr/0003)
export const PART = 'ticketing';
// Contracts this CLI speaks with the bundle; 3 requires the token name with every board (CR-TOK-1), always passed here, so both work
export const CONTRACTS = [2, 3];
export const CONTRACT = Math.max(...CONTRACTS);
// The one entry the CLI loads; it re-exports what the CLI needs from the library
export const ENTRY = 'scripts/cli-facade.mjs';

const FILES = [ENTRY, 'routing.default.json', 'package.json'];

const inside = (dir, f) => { const rel = path.relative(dir, f); return rel && !rel.startsWith('..') && !path.isAbsolute(rel); };

// The ticketing folder of a bundle, null when the bundle is older than ticketing or misses a file; only a folder that really lies
// inside the bundles folder of this machine, so no link or path can make kette load code from elsewhere (KETTE-28)
export function ticketingDir(bundleDir, { root = bundlesDir() } = {}) {
  if (!bundleDir) return null;
  const dir = path.join(bundleDir, PART);
  if (!FILES.every((f) => fs.existsSync(path.join(dir, f)))) return null;
  let real;
  let realRoot;
  try { real = fs.realpathSync(dir); realRoot = fs.realpathSync(root); } catch { return null; }
  return inside(realRoot, real) && FILES.every((f) => inside(real, fs.realpathSync(path.join(real, f)))) ? real : null;
}

// The facade of the library from the active Enterprise bundle
export async function loadTicketing(bundleDir, opts = {}) {
  const dir = ticketingDir(bundleDir, opts);
  if (!dir) throw new ExitError(`The Enterprise bundle on this machine has no ticketing yet. Load the current one with: ${cmd('kette update')}`, 1);
  const lib = await import(pathToFileURL(path.join(dir, ENTRY)).href);
  if (!CONTRACTS.includes(lib.CLI_CONTRACT)) {
    const newer = Number(lib.CLI_CONTRACT) > CONTRACT;
    throw new ExitError(`The ticketing in the Enterprise bundle speaks contract ${lib.CLI_CONTRACT}, this kette speaks ${CONTRACTS.join(' or ')}. ${newer ? 'Update the kette CLI (run the installer again).' : `Load the current bundle with: ${cmd('kette update')}`}`, 1);
  }
  return { dir, lib };
}
