import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { COMMUNITY, ENTERPRISE, RENAMED_PLUGINS, editionLabel, pluginsFor } from './editions.mjs';
import { MARKETPLACE, enablePlugins, manualInstall, pluginId } from './claude.mjs';
import { MARKETS, buildMarketplace, marketDir, marketName } from './marketplace.mjs';
import { apply, describe } from './plan.mjs';
import { cmd, status } from './out.mjs';

// Plugins are switched on per project in .claude/settings.json (shared with the team), never in the user settings of Claude Code
export const SETTINGS_PATH = '.claude/settings.json';
// The machine path of the marketplace lives here (local scope), so it must stay out of git
export const LOCAL_SETTINGS_PATH = '.claude/settings.local.json';
const EDITIONS = [COMMUNITY, ENTERPRISE];
const ALL_NAMES = [...new Set([...pluginsFor(COMMUNITY), ...pluginsFor(ENTERPRISE), ...Object.keys(RENAMED_PLUGINS)])];

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const KETTE_ID = new RegExp(`@(${[MARKETPLACE, ...Object.values(MARKETS)].join('|')})$`);
export const isKetteId = (id) => KETTE_ID.test(id);

// true for the plugins of the edition under its own marketplace; false for the other edition and for the legacy marketplace kette,
// whose plugins an older kette put in the user scope; plugins of other marketplaces are never touched
export function projectPlugins(edition) {
  const ids = {};
  for (const e of EDITIONS) for (const p of pluginsFor(e)) ids[pluginId(p, marketName(e))] = e === edition;
  for (const p of ALL_NAMES) ids[pluginId(p, MARKETPLACE)] = false;
  return ids;
}

function parse(text) {
  if (!text.trim()) return {};
  try { const v = JSON.parse(text); return isObject(v) ? v : null; } catch { return null; }
}

const json = (v) => `${JSON.stringify(v, null, 2)}\n`;

// Merges the Kette entries into enabledPlugins and keeps every other setting; a file that is not a JSON object stays as it is
export function renewSettings(current, edition) {
  const settings = parse(current);
  if (!settings) return current;
  const enabled = isObject(settings.enabledPlugins) ? settings.enabledPlugins : {};
  const want = projectPlugins(edition);
  if (Object.entries(want).every(([id, on]) => enabled[id] === on)) return current;
  return json({ ...settings, enabledPlugins: { ...enabled, ...want } });
}

// Local settings: the marketplace of the edition with its machine path; a local Kette entry that differs from the project file is
// dropped, because local settings win in Claude Code and would switch the other edition back on
export function renewLocalSettings(current, edition, dir) {
  const settings = parse(current);
  if (!settings) return current;
  const want = projectPlugins(edition);
  const enabled = isObject(settings.enabledPlugins) ? settings.enabledPlugins : {};
  const kept = Object.fromEntries(Object.entries(enabled).filter(([id, on]) => !isKetteId(id) || want[id] === on));
  const markets = isObject(settings.extraKnownMarketplaces) ? settings.extraKnownMarketplaces : {};
  const next = { ...settings, extraKnownMarketplaces: { ...markets, [marketName(edition)]: { source: { source: 'directory', path: dir } } } };
  if (Object.keys(kept).length) next.enabledPlugins = kept;
  else delete next.enabledPlugins;
  return JSON.stringify(next) === JSON.stringify(settings) ? current : json(next);
}

// Temp files kette writes next to a project file (.<name>.<pid>.<hex>.tmp); one left by a killed kette never ends up in git (CR-AT-5)
export const TEMP_PATTERN = '.*.[0-9]*.[0-9a-f]*.tmp';
const IGNORED = [LOCAL_SETTINGS_PATH, TEMP_PATTERN];

// Adds the lines that are missing at the end, keeps every other line and the line endings
export function renewIgnore(current) {
  const lines = current.split(/\r?\n/).map((l) => l.trim());
  const missing = IGNORED.filter((l) => !lines.includes(l));
  if (!missing.length) return current;
  const eol = current.includes('\r\n') ? '\r\n' : '\n';
  const head = current && !current.endsWith('\n') ? `${current}${eol}` : current;
  return `${head}${missing.join(eol)}${eol}`;
}

export function settingsItems(edition) {
  const dir = marketDir(edition);
  return [
    { path: SETTINGS_PATH, mode: 'renew', content: renewSettings('', edition), renew: (current) => renewSettings(current, edition), note: `Claude Code plugins of ${editionLabel(edition)} for this project` },
    { path: LOCAL_SETTINGS_PATH, mode: 'renew', content: renewLocalSettings('', edition, dir), renew: (current) => renewLocalSettings(current, edition, dir), note: 'marketplace path on this machine, git ignored' },
    { path: '.gitignore', mode: 'renew', content: renewIgnore(''), renew: renewIgnore, note: 'machine path of the marketplace and temp files of kette stay local' },
  ];
}

export function writeProjectSettings(root, edition) {
  const described = describe(settingsItems(edition), root);
  apply(described, root);
  return described;
}

const readSettings = (f) => (fs.existsSync(f) ? parse(fs.readFileSync(f, 'utf8')) : {});

// ok, missing, broken or drift (with the plugin IDs that differ); local settings count, Claude Code lets them win
export function settingsStatus(root, edition) {
  const f = path.join(root, SETTINGS_PATH);
  if (!fs.existsSync(f)) return { state: 'missing', wrong: [], local: [] };
  const settings = readSettings(f);
  const local = readSettings(path.join(root, LOCAL_SETTINGS_PATH));
  if (!settings || !local) return { state: 'broken', wrong: [], local: [], file: settings ? LOCAL_SETTINGS_PATH : SETTINGS_PATH };
  const shared = isObject(settings.enabledPlugins) ? settings.enabledPlugins : {};
  const mine = isObject(local.enabledPlugins) ? local.enabledPlugins : {};
  const effective = { ...shared, ...mine };
  const want = projectPlugins(edition);
  const wrong = Object.entries(want).filter(([id, on]) => effective[id] !== on).map(([id]) => id);
  return { state: wrong.length ? 'drift' : 'ok', wrong, local: wrong.filter((id) => id in mine) };
}

// User settings of Claude Code, read only: Kette plugins switched on there come from CLI versions before 0.10
export const userSettingsFile = () => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json');

export function userScopePlugins() {
  let settings;
  try { settings = JSON.parse(fs.readFileSync(userSettingsFile(), 'utf8')); } catch { return []; }
  const enabled = isObject(settings?.enabledPlugins) ? settings.enabledPlugins : {};
  return Object.keys(enabled).filter((id) => isKetteId(id) && enabled[id] === true).sort();
}

// The edition plugins in its marketplace; an old Community bundle may still name ui-laws ui-gesetze
function available(edition, plugins) {
  const names = pluginsFor(edition).map((p) => (plugins.includes(p) ? p : Object.keys(RENAMED_PLUGINS).find((old) => RENAMED_PLUGINS[old] === p && plugins.includes(old)) || p));
  return { present: names.filter((p) => plugins.includes(p)), missing: names.filter((p) => !plugins.includes(p)) };
}

// The edition bundle to its marketplace folder, then its plugins into the project scope of Claude Code
export function enableProjectPlugins(root, edition, bundle) {
  const market = buildMarketplace(edition, bundle);
  const { present, missing } = available(edition, market.plugins);
  const result = present.length ? enablePlugins(market.dir, present, path.resolve(root), marketName(edition)) : { ok: true };
  return { ...result, present, missing, dir: market.dir, market: marketName(edition) };
}

export function enableHints(result, edition) {
  const lines = [];
  if (!result.ok) lines.push(`Plugins not enabled for this project (${result.reason}). By hand in the project folder:${manualInstall(result.dir, result.present, result.market)}`);
  if (result.missing.length) {
    const why = edition === ENTERPRISE ? `the Enterprise bundle is not on this machine. Unlock with: ${cmd('kette login <key>')}` : `the Community bundle on this machine does not contain them. Load it with: ${cmd('kette update')}`;
    lines.push(`${status('warn', 'WARN')} ${result.missing.join(', ')} not enabled, ${why}`);
  }
  return lines;
}
