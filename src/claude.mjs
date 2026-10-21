import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { bundlesDir } from './paths.mjs';
import { missingPlugins, pluginsFor } from './editions.mjs';

// Eigener Name, damit der Entwickler-Marketplace kette-engineering (Repo) nicht getroffen wird
export const MARKETPLACE = 'kette';
// Name bis 0.3.0; zeigt er in ~/.kette, hat ihn die CLI selbst angelegt
const LEGACY_MARKETPLACE = 'kette-engineering';
const ALL_PLUGINS = ['kette-engineering-core', 'kette-engineering'];
// Marketplace des einzeln verkauften Agenten-Packs, dessen Plugins auch im Paket der Kette stecken
const PACK_MARKETPLACE = 'claude-design-agent-pack';
const PACK_PLUGINS = ['ui-gesetze', 'design-system-agents', 'design-review-pack'];
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

// Erfolg zeigt die Plugin-Liste danach, nicht der Text der Antwort
function uninstall(id) {
  const r = run(['plugin', 'uninstall', id]);
  return listed(installedPlugins(), id) ? { ok: false, reason: output(r) || `${id} ist nach dem Entfernen noch installiert` } : { ok: true };
}

// Hinweis auf Plugins eines fremden Marketplaces, die zusätzlich zu kette aktiv sind und Skills doppelt zeigen
function duplicateHint(market, ids, list) {
  const active = ids.filter((id) => listed(list, id));
  if (!active.length) return;
  console.log(`HINW  Marketplace ${market.name} (${market.path || market.source}) bleibt unangetastet. Seine Plugins sind zusätzlich zu ${MARKETPLACE} aktiv, Skills erscheinen doppelt. Deaktivieren mit: ${active.map((id) => `claude plugin disable ${id}`).join(' && ')}`);
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
  duplicateHint(legacy, ALL_PLUGINS.map((p) => pluginId(p, LEGACY_MARKETPLACE)), installedPlugins());
  return { ok: true };
}

// Das Agenten-Pack einzeln installiert (ZIP aus dem Kauf): seine Plugins, die kette jetzt auch installiert, erscheinen doppelt
function packDuplicates(all, plugins) {
  const pack = all.find((m) => m.name === PACK_MARKETPLACE);
  if (pack) duplicateHint(pack, plugins.filter((p) => PACK_PLUGINS.includes(p)).map((p) => pluginId(p, PACK_MARKETPLACE)), installedPlugins());
}

// Befehle zum Einrichten von Hand, wenn die CLI Claude Code nicht steuern kann
export const manualInstall = (source, plugins) => ['', `claude plugin marketplace add "${source}"`, ...plugins.map((p) => `claude plugin install ${pluginId(p)}`)].join('\n  ');

// Bindet das Regelwerk als Plugin-Marketplace in Claude Code ein (Scope user); source ist der feste Link auf das aktive Paket
// retire: Plugins der anderen Edition, die entfernt werden, solange der Marketplace sie noch kennt
export function installPlugins(source, plugins, retire = []) {
  if (!hasClaude()) return { ok: false, reason: 'claude nicht gefunden' };
  const all = marketplaces();
  const migrated = migrateLegacy(all);
  if (!migrated.ok) return migrated;
  let known = all.find((m) => m.name === MARKETPLACE) || null;
  const moved = known?.path && path.resolve(known.path) !== path.resolve(source);
  // Fremde Marketplaces gleichen Namens bleiben unangetastet, geprüft bevor etwas entfernt wird
  if (moved && !insideKette(known.path)) return { ok: false, reason: `Marketplace ${MARKETPLACE} zeigt auf ${known.path}. Umstellen mit: claude plugin marketplace remove ${MARKETPLACE} && claude plugin marketplace add "${source}"` };
  const list = retire.length ? installedPlugins() : '';
  const retired = [];
  for (const p of retire.filter((name) => listed(list, pluginId(name)))) {
    const r = uninstall(pluginId(p));
    if (!r.ok) return r;
    retired.push(pluginId(p));
  }
  // Scheitert ein späterer Schritt, steht im Grund, was schon entfernt wurde
  const fail = (reason) => ({ ok: false, reason: retired.length ? `${reason}; vorher schon entfernt: ${retired.join(', ')}` : reason });
  packDuplicates(all, plugins);
  if (moved) {
    const rm = run(['plugin', 'marketplace', 'remove', MARKETPLACE]);
    if (rm.status !== 0) return fail(output(rm));
    known = null;
  }
  const step = known ? run(['plugin', 'marketplace', 'update', MARKETPLACE]) : run(['plugin', 'marketplace', 'add', source]);
  if (step.status !== 0 && !/already/i.test(output(step))) return fail(output(step));
  for (const p of plugins) {
    const id = pluginId(p);
    let r = run(['plugin', 'install', id]);
    if (r.status !== 0 && /already/i.test(output(r))) r = run(['plugin', 'update', id]);
    if (r.status !== 0) return fail(`${id}: ${output(r)}`);
  }
  return { ok: true };
}

// Installiert die Plugins der Edition, die das Paket enthält; fehlende meldet editionHints, statt daran zu scheitern
export function installEdition(link, tier, retire = []) {
  const missing = missingPlugins(link, tier);
  const present = pluginsFor(tier).filter((p) => !missing.includes(p));
  return { ...installPlugins(link, present, retire), present, missing };
}

export function editionHints(result, link) {
  const lines = [];
  if (!result.ok) lines.push(`Plugins nicht installiert (${result.reason}). Von Hand:${manualInstall(link, result.present)}`);
  if (result.missing.length) lines.push(`HINW  Das Paket auf diesem Rechner enthält ${result.missing.join(', ')} noch nicht. Neu laden mit: kette update`);
  return lines;
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
