import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { bundlesDir } from './paths.mjs';

// Eigener Name, damit der Entwickler-Marketplace kette-engineering (Repo) nicht getroffen wird
export const MARKETPLACE = 'kette';
// Name bis 0.3.0; zeigt er in ~/.kette, hat ihn die CLI selbst angelegt
const LEGACY_MARKETPLACE = 'kette-engineering';
const ALL_PLUGINS = ['kette-engineering-core', 'kette-engineering'];
export const pluginId = (name, market = MARKETPLACE) => `${name}@${market}`;

const run = (args) => spawnSync('claude', args, { encoding: 'utf8' });
const output = (r) => ((r.stdout || '') + (r.stderr || '')).trim();
export const hasClaude = () => run(['--version']).status === 0;

function marketplaces() {
  const r = run(['plugin', 'marketplace', 'list', '--json']);
  if (r.status !== 0) return [];
  try { return JSON.parse(r.stdout); } catch { return []; }
}

const insideKette = (p) => !path.relative(bundlesDir(), path.resolve(p)).startsWith('..');
// Plugin-ID als ganzes Wort, damit kette-engineering@kette nicht kette-engineering@kette-engineering trifft
const listed = (list, id) => new RegExp(`(^|\\s)${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`, 'm').test(list);

function uninstall(id) {
  const r = run(['plugin', 'uninstall', id]);
  return r.status === 0 || /not installed|not found/i.test(output(r)) ? { ok: true } : { ok: false, reason: output(r) };
}

// Alten, selbst angelegten Marketplace entfernen; einer auf ein Repo bleibt, dann Hinweis auf doppelte Skills
function migrateLegacy(all) {
  const legacy = all.find((m) => m.name === LEGACY_MARKETPLACE);
  if (!legacy?.path) return { ok: true };
  if (insideKette(legacy.path)) {
    for (const p of ALL_PLUGINS) {
      const r = uninstall(pluginId(p, LEGACY_MARKETPLACE));
      if (!r.ok) return r;
    }
    const rm = run(['plugin', 'marketplace', 'remove', LEGACY_MARKETPLACE]);
    return rm.status === 0 ? { ok: true } : { ok: false, reason: output(rm) };
  }
  const list = installedPlugins();
  const active = ALL_PLUGINS.map((p) => pluginId(p, LEGACY_MARKETPLACE)).filter((id) => listed(list, id));
  if (active.length) {
    console.log(`HINW  Marketplace ${LEGACY_MARKETPLACE} (${legacy.path}) bleibt unangetastet. Seine Plugins sind zusätzlich zu ${MARKETPLACE} aktiv, Skills erscheinen doppelt. Deaktivieren mit: ${active.map((id) => `claude plugin disable ${id}`).join(' && ')}`);
  }
  return { ok: true };
}

// Bindet das Regelwerk als Plugin-Marketplace in Claude Code ein (Scope user); source ist der feste Link auf das aktive Paket
export function installPlugins(source, plugins) {
  if (!hasClaude()) return { ok: false, reason: 'claude nicht gefunden' };
  const all = marketplaces();
  const migrated = migrateLegacy(all);
  if (!migrated.ok) return migrated;
  let known = all.find((m) => m.name === MARKETPLACE) || null;
  if (known?.path && path.resolve(known.path) !== path.resolve(source)) {
    // Fremde Marketplaces gleichen Namens bleiben unangetastet
    if (!insideKette(known.path)) return { ok: false, reason: `Marketplace ${MARKETPLACE} zeigt auf ${known.path}. Umstellen mit: claude plugin marketplace remove ${MARKETPLACE} && claude plugin marketplace add ${source}` };
    const rm = run(['plugin', 'marketplace', 'remove', MARKETPLACE]);
    if (rm.status !== 0) return { ok: false, reason: output(rm) };
    known = null;
  }
  const step = known ? run(['plugin', 'marketplace', 'update', MARKETPLACE]) : run(['plugin', 'marketplace', 'add', source]);
  if (step.status !== 0 && !/already/i.test(output(step))) return { ok: false, reason: output(step) };
  for (const p of plugins) {
    const id = pluginId(p);
    let r = run(['plugin', 'install', id]);
    if (r.status !== 0 && /already/i.test(output(r))) r = run(['plugin', 'update', id]);
    if (r.status !== 0) return { ok: false, reason: output(r) };
  }
  return { ok: true };
}

export function uninstallPlugin(name) {
  if (!hasClaude()) return { ok: false, reason: 'claude nicht gefunden' };
  return uninstall(pluginId(name));
}

export function installedPlugins() {
  const r = run(['plugin', 'list']);
  return r.status === 0 ? r.stdout : '';
}

export const pluginInstalled = (name, list = installedPlugins()) => listed(list, pluginId(name));
