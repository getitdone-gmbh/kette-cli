import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { bundlesDir } from './paths.mjs';

const MARKETPLACE = 'kette-engineering';
const run = (args) => spawnSync('claude', args, { encoding: 'utf8' });
const output = (r) => ((r.stdout || '') + (r.stderr || '')).trim();
export const hasClaude = () => run(['--version']).status === 0;

function knownMarketplace() {
  const r = run(['plugin', 'marketplace', 'list', '--json']);
  if (r.status !== 0) return null;
  try { return JSON.parse(r.stdout).find((m) => m.name === MARKETPLACE) || null; } catch { return null; }
}

const insideKette = (p) => !path.relative(bundlesDir(), path.resolve(p)).startsWith('..');

// Bindet das Regelwerk als Plugin-Marketplace in Claude Code ein (Scope user); source ist der feste Link auf das aktive Paket
export function installPlugins(source, plugins) {
  if (!hasClaude()) return { ok: false, reason: 'claude nicht gefunden' };
  let known = knownMarketplace();
  if (known?.path && path.resolve(known.path) !== path.resolve(source)) {
    // Fremde Marketplaces (z. B. ein Arbeitsstand des Regelwerks) bleiben unangetastet
    if (!insideKette(known.path)) return { ok: false, reason: `Marketplace ${MARKETPLACE} zeigt auf ${known.path}. Umstellen mit: claude plugin marketplace remove ${MARKETPLACE} && claude plugin marketplace add ${source}` };
    const rm = run(['plugin', 'marketplace', 'remove', MARKETPLACE]);
    if (rm.status !== 0) return { ok: false, reason: output(rm) };
    known = null;
  }
  const step = known ? run(['plugin', 'marketplace', 'update', MARKETPLACE]) : run(['plugin', 'marketplace', 'add', source]);
  if (step.status !== 0 && !/already/i.test(output(step))) return { ok: false, reason: output(step) };
  for (const p of plugins) {
    const id = `${p}@${MARKETPLACE}`;
    let r = run(['plugin', 'install', id]);
    if (r.status !== 0 && /already/i.test(output(r))) r = run(['plugin', 'update', id]);
    if (r.status !== 0) return { ok: false, reason: output(r) };
  }
  return { ok: true };
}

export function uninstallPlugin(name) {
  if (!hasClaude()) return { ok: false, reason: 'claude nicht gefunden' };
  const r = run(['plugin', 'uninstall', `${name}@${MARKETPLACE}`]);
  return r.status === 0 || /not installed|not found/i.test(output(r)) ? { ok: true } : { ok: false, reason: output(r) };
}

export function installedPlugins() {
  const r = run(['plugin', 'list']);
  return r.status === 0 ? r.stdout : '';
}
