import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { bundlesDir } from './paths.mjs';
import { missingPlugins, pluginsFor } from './editions.mjs';
import { cmd, status } from './out.mjs';

// Own name, so the developer marketplace kette-engineering (repo) is never hit
export const MARKETPLACE = 'kette';
// Name up to 0.3.0; if it points into ~/.kette, the CLI created it itself
const LEGACY_MARKETPLACE = 'kette-engineering';
const ALL_PLUGINS = ['kette-engineering-core', 'kette-engineering'];
// Marketplace of the separately sold agent pack, whose plugins are also in the Die Kette bundle
const PACK_MARKETPLACE = 'claude-design-agent-pack';
const PACK_PLUGINS = ['ui-gesetze', 'design-system-agents', 'design-review-pack'];
export const pluginId = (name, market = MARKETPLACE) => `${name}@${market}`;

// npm installs Claude Code on Windows as claude.cmd, which only starts through cmd.exe; the command line is built here from fixed values,
// arguments with quotes, percent signs, line breaks or a trailing backslash (it would escape the closing quote) are refused
export function cmdLine(args) {
  if (args.some((a) => /["%\r\n]|\\$/.test(a))) return null;
  return ['claude.cmd', ...args.map((a) => (/[\s&|<>^()]/.test(a) ? `"${a}"` : a))].join(' ');
}
function run(args) {
  if (process.platform !== 'win32') return spawnSync('claude', args, { encoding: 'utf8' });
  const exe = spawnSync('claude.exe', args, { encoding: 'utf8' });
  if (exe.error?.code !== 'ENOENT') return exe;
  const line = cmdLine(args);
  if (!line) return { status: 1, stdout: '', stderr: `Argument not safe for claude.cmd: ${args.join(' ')}` };
  return spawnSync(line, { encoding: 'utf8', shell: true });
}
const output = (r) => ((r.stdout || '') + (r.stderr || '')).trim();
export const hasClaude = () => run(['--version']).status === 0;

function marketplaces() {
  const r = run(['plugin', 'marketplace', 'list', '--json']);
  if (r.status !== 0) return [];
  try { return JSON.parse(r.stdout); } catch { return []; }
}

const insideKette = (p) => !path.relative(bundlesDir(), path.resolve(p)).startsWith('..');
// Plugin ID as a whole word, so kette-engineering@kette does not match kette-engineering@kette-engineering; list null (not readable) never matches
const listed = (list, id) => list !== null && new RegExp(`(^|\\s)${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`, 'm').test(list);

// Success is decided by the plugin list afterwards, not the reply text; if the list is not readable, the exit status decides
function uninstall(id) {
  const r = run(['plugin', 'uninstall', id]);
  const list = installedPlugins();
  // Reply of Claude Code when the plugin is already gone: counts as removed
  const absent = /not found in installed plugins/i.test(output(r));
  const gone = list === null ? r.status === 0 || absent : !listed(list, id);
  return gone ? { ok: true } : { ok: false, reason: output(r) || `${id} is still installed after removal` };
}

// Hint about plugins of a foreign marketplace that are active next to kette and show skills twice
function duplicateHint(market, ids, list) {
  const active = ids.filter((id) => listed(list, id));
  if (!active.length) return;
  console.log(`${status('warn', 'WARN')} Marketplace ${market.name} (${market.path || market.source}) stays untouched. Its plugins are active in addition to ${MARKETPLACE}, skills show up twice. Disable with: ${cmd(active.map((id) => `claude plugin disable ${id}`).join(' && '))}`);
}

// Remove the old marketplace the CLI created; one pointing to a repo stays, with a hint about duplicate skills
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

// Agent pack installed on its own (ZIP from the purchase): its plugins that kette now installs too show up twice
function packDuplicates(all, plugins) {
  const pack = all.find((m) => m.name === PACK_MARKETPLACE);
  if (pack) duplicateHint(pack, plugins.filter((p) => PACK_PLUGINS.includes(p)).map((p) => pluginId(p, PACK_MARKETPLACE)), installedPlugins());
}

// Commands for a manual setup when the CLI cannot drive Claude Code
export const manualInstall = (source, plugins) => ['', `claude plugin marketplace add "${source}"`, ...plugins.map((p) => `claude plugin install ${pluginId(p)}`)].join('\n  ');

// Adds the rulebook as a plugin marketplace to Claude Code (scope user); source is the fixed link to the active bundle
// retire: plugins of the other edition, removed while the marketplace still knows them
export function installPlugins(source, plugins, retire = []) {
  if (!hasClaude()) return { ok: false, reason: 'claude not found' };
  const all = marketplaces();
  const migrated = migrateLegacy(all);
  if (!migrated.ok) return migrated;
  let known = all.find((m) => m.name === MARKETPLACE) || null;
  const moved = known?.path && path.resolve(known.path) !== path.resolve(source);
  // Foreign marketplaces with the same name stay untouched, checked before anything is removed
  if (moved && !insideKette(known.path)) return { ok: false, reason: `Marketplace ${MARKETPLACE} points to ${known.path}. Switch with: claude plugin marketplace remove ${MARKETPLACE} && claude plugin marketplace add "${source}"` };
  const list = retire.length ? installedPlugins() : '';
  const retired = [];
  // Without a readable list, try to remove every plugin of the other edition instead of silently skipping it
  for (const p of retire.filter((name) => list === null || listed(list, pluginId(name)))) {
    const r = uninstall(pluginId(p));
    if (!r.ok) return r;
    retired.push(pluginId(p));
  }
  // If a later step fails, the reason says what was already removed
  const fail = (reason) => ({ ok: false, reason: retired.length ? `${reason}; already removed before: ${retired.join(', ')}` : reason });
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

// Installs the edition plugins the bundle contains; editionHints reports missing ones instead of failing
export function installEdition(link, tier, retire = []) {
  const missing = missingPlugins(link, tier);
  const present = pluginsFor(tier).filter((p) => !missing.includes(p));
  return { ...installPlugins(link, present, retire), present, missing };
}

export function editionHints(result, link) {
  const lines = [];
  if (!result.ok) lines.push(`Plugins not installed (${result.reason}). By hand:${manualInstall(link, result.present)}`);
  if (result.missing.length) lines.push(`${status('warn', 'WARN')} The bundle on this machine does not contain ${result.missing.join(', ')} yet. Reload with: ${cmd('kette update')}`);
  return lines;
}

export function uninstallPlugin(name) {
  if (!hasClaude()) return { ok: false, reason: 'claude not found' };
  return uninstall(pluginId(name));
}

// Output of claude plugin list, null when the call fails
export function installedPlugins() {
  const r = run(['plugin', 'list']);
  return r.status === 0 ? r.stdout : null;
}

export const pluginInstalled = (name, list = installedPlugins()) => listed(list, pluginId(name));
