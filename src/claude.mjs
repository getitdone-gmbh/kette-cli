import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { bundlesDir } from './paths.mjs';
import { RENAMED_PLUGINS } from './editions.mjs';
import { cmd, status } from './out.mjs';

// Own name, so the developer marketplace kette-engineering (repo) is never hit
export const MARKETPLACE = 'kette';
// Name up to 0.3.0; if it points into ~/.kette, the CLI created it itself
const LEGACY_MARKETPLACE = 'kette-engineering';
const ALL_PLUGINS = ['kette-engineering-core', 'kette-engineering'];
// Marketplace of the separately sold agent pack, whose plugins are also in the Die Kette bundle
const PACK_MARKETPLACE = 'claude-design-agent-pack';
const PACK_PLUGINS = ['ui-laws', 'design-system-agents', 'design-review-pack'];
// A plugin and its names before a rename, so an older pack install is found too
const withOldNames = (p) => [p, ...Object.keys(RENAMED_PLUGINS).filter((old) => RENAMED_PLUGINS[old] === p)];
export const pluginId = (name, market = MARKETPLACE) => `${name}@${market}`;

// npm installs Claude Code on Windows as claude.cmd, which only starts through cmd.exe; the command line is built here from fixed values,
// arguments with quotes, percent signs, line breaks or a trailing backslash (it would escape the closing quote) are refused
export function cmdLine(args, bin = 'claude.cmd') {
  if (args.some((a) => /["%\r\n]|\\$/.test(a))) return null;
  return [bin, ...args.map((a) => (/[\s&|<>^()]/.test(a) ? `"${a}"` : a))].join(' ');
}
// cwd: the project folder for project and local scope, Claude Code resolves those scopes from where it runs
export function runClaude(args, { cwd } = {}) {
  const base = { encoding: 'utf8', ...(cwd ? { cwd } : {}) };
  if (process.platform !== 'win32') return spawnSync('claude', args, base);
  const exe = spawnSync('claude.exe', args, base);
  if (exe.error?.code !== 'ENOENT') return exe;
  const line = cmdLine(args);
  if (!line) return { status: 1, stdout: '', stderr: `Argument not safe for claude.cmd: ${args.join(' ')}` };
  return spawnSync(line, { ...base, shell: true });
}
export const output = (r) => ((r.stdout || '') + (r.stderr || '')).trim();
export const hasClaude = () => runClaude(['--version']).status === 0;

function marketplaces() {
  const r = runClaude(['plugin', 'marketplace', 'list', '--json']);
  if (r.status !== 0) return [];
  try { return JSON.parse(r.stdout); } catch { return []; }
}

const insideKette = (p) => !path.relative(bundlesDir(), path.resolve(p)).startsWith('..');
// Plugin ID as a whole word, so kette-engineering@kette does not match kette-engineering@kette-engineering; list null (not readable) never matches
const listed = (list, id) => list !== null && new RegExp(`(^|\\s)${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`, 'm').test(list);

// Success is decided by the plugin list afterwards, not the reply text; if the list is not readable, the exit status decides
function uninstall(id) {
  const r = runClaude(['plugin', 'uninstall', id]);
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
    const rm = runClaude(['plugin', 'marketplace', 'remove', LEGACY_MARKETPLACE]);
    return rm.status === 0 ? { ok: true } : { ok: false, reason: output(rm) };
  }
  duplicateHint(legacy, ALL_PLUGINS.map((p) => pluginId(p, LEGACY_MARKETPLACE)), installedPlugins());
  return { ok: true };
}

// Agent pack installed on its own (ZIP from the purchase): its plugins that kette now installs too show up twice
function packDuplicates(all, plugins) {
  const pack = all.find((m) => m.name === PACK_MARKETPLACE);
  if (pack) duplicateHint(pack, plugins.filter((p) => PACK_PLUGINS.includes(p)).flatMap(withOldNames).map((p) => pluginId(p, PACK_MARKETPLACE)), installedPlugins());
}

// Commands for a manual setup in the project folder when the CLI cannot drive Claude Code
export const manualInstall = (source, plugins) => ['', `claude plugin marketplace add --scope local "${source}"`, ...plugins.map((p) => `claude plugin install ${pluginId(p)} --scope project`)].join('\n  ');

// Plugins for one project only: the marketplace is declared in .claude/settings.local.json (local scope, the path differs per machine),
// each plugin is installed with scope project, so it lands in .claude/settings.json of the repo and never in the user settings
export function enablePlugins(source, plugins, root) {
  if (!hasClaude()) return { ok: false, reason: 'claude not found' };
  const all = marketplaces();
  const migrated = migrateLegacy(all);
  if (!migrated.ok) return migrated;
  const known = all.find((m) => m.name === MARKETPLACE);
  // Claude Code keeps one path per marketplace name for all projects, so a foreign marketplace kette is never repointed
  if (known?.path && !insideKette(known.path)) return { ok: false, reason: `Marketplace ${MARKETPLACE} points to ${known.path}. Switch with: claude plugin marketplace remove ${MARKETPLACE}, then run kette add again` };
  packDuplicates(all, plugins);
  const add = runClaude(['plugin', 'marketplace', 'add', '--scope', 'local', source], { cwd: root });
  if (add.status !== 0 && !/already/i.test(output(add))) return { ok: false, reason: output(add) };
  // The folder is rebuilt when a bundle changes, update makes Claude Code read it again
  const refresh = runClaude(['plugin', 'marketplace', 'update', MARKETPLACE], { cwd: root });
  if (refresh.status !== 0) return { ok: false, reason: output(refresh) };
  for (const p of plugins) {
    const id = pluginId(p);
    let r = runClaude(['plugin', 'install', id, '--scope', 'project'], { cwd: root });
    if (r.status !== 0 && /already/i.test(output(r))) r = runClaude(['plugin', 'update', id, '--scope', 'project'], { cwd: root });
    if (r.status !== 0) return { ok: false, reason: `${id}: ${output(r)}` };
  }
  return { ok: true };
}

export function uninstallPlugin(name) {
  if (!hasClaude()) return { ok: false, reason: 'claude not found' };
  return uninstall(pluginId(name));
}

// Output of claude plugin list, null when the call fails; root lists what Claude Code loads in that project
export function installedPlugins(root) {
  const r = runClaude(['plugin', 'list'], { cwd: root });
  return r.status === 0 ? r.stdout : null;
}

export const pluginInstalled = (name, list = installedPlugins()) => listed(list, pluginId(name));
