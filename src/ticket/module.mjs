import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ExitError } from '../errors.mjs';
import { cmd } from '../out.mjs';

// The ticketing library is Enterprise and never part of this public package: it ships in the Enterprise bundle (docs/adr/0003)
export const PART = 'ticketing';
// Contract between this CLI and the library in the bundle; a bundle with another one is refused instead of driven blindly
export const CONTRACT = 1;

const FILES = ['dist/index.js', 'routing.json', 'scripts/plan-guard.mjs', 'scripts/workbase-session.mjs', 'scripts/intake-hook.mjs'];

// The ticketing folder of a bundle, null when the bundle is older than ticketing or misses a file
export function ticketingDir(bundleDir) {
  const dir = bundleDir && path.join(bundleDir, PART);
  return dir && FILES.every((f) => fs.existsSync(path.join(dir, f))) ? dir : null;
}

const load = (dir, file) => import(pathToFileURL(path.join(dir, file)).href);

// Library, plan guard, shared session, intake hook and the default routing from the active Enterprise bundle
export async function loadTicketing(bundleDir) {
  const dir = ticketingDir(bundleDir);
  if (!dir) throw new ExitError(`The Enterprise bundle on this machine has no ticketing yet. Load the current one with: ${cmd('kette update')}`, 1);
  const lib = await load(dir, 'dist/index.js');
  if (lib.CLI_CONTRACT !== CONTRACT) {
    const newer = Number(lib.CLI_CONTRACT) > CONTRACT;
    throw new ExitError(`The ticketing in the Enterprise bundle speaks contract ${lib.CLI_CONTRACT}, this kette speaks ${CONTRACT}. ${newer ? 'Update the kette CLI (run the installer again).' : `Load the current bundle with: ${cmd('kette update')}`}`, 1);
  }
  const [guard, session, hook] = await Promise.all(['scripts/plan-guard.mjs', 'scripts/workbase-session.mjs', 'scripts/intake-hook.mjs'].map((f) => load(dir, f)));
  return { dir, lib, guard, session, hook, routing: JSON.parse(fs.readFileSync(path.join(dir, 'routing.json'), 'utf8')) };
}
