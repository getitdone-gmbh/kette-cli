import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { COMMUNITY, ENTERPRISE, RENAMED_PLUGINS, editionLabel, pluginsFor } from './editions.mjs';
import { enablePlugins, manualInstall, pluginId } from './claude.mjs';
import { buildMarketplace } from './marketplace.mjs';
import { apply, describe } from './plan.mjs';
import { cmd, status } from './out.mjs';

// Plugins are switched on per project in .claude/settings.json (shared with the team), never in the user settings of Claude Code
export const SETTINGS_PATH = '.claude/settings.json';
// Claude Code writes the machine path of the marketplace here (local scope), so it must stay out of git
export const LOCAL_SETTINGS_PATH = '.claude/settings.local.json';
// Every plugin of both editions, so the other edition is switched off explicitly; old names stay out, an old bundle may still need one
const KNOWN = [...new Set([...pluginsFor(COMMUNITY), ...pluginsFor(ENTERPRISE)])];

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

// true for the plugins of the edition, false for every other Kette plugin; plugins of other marketplaces are never touched
export const projectPlugins = (edition) => Object.fromEntries(KNOWN.map((p) => [pluginId(p), pluginsFor(edition).includes(p)]));

function parse(text) {
  if (!text.trim()) return {};
  try { const v = JSON.parse(text); return isObject(v) ? v : null; } catch { return null; }
}

// Merges the Kette entries into enabledPlugins and keeps every other setting; a file that is not a JSON object stays as it is
export function renewSettings(current, edition) {
  const settings = parse(current);
  if (!settings) return current;
  const enabled = isObject(settings.enabledPlugins) ? settings.enabledPlugins : {};
  const want = projectPlugins(edition);
  if (Object.entries(want).every(([id, on]) => enabled[id] === on)) return current;
  return `${JSON.stringify({ ...settings, enabledPlugins: { ...enabled, ...want } }, null, 2)}\n`;
}

export function settingsItems(edition) {
  return [
    { path: SETTINGS_PATH, mode: 'renew', content: renewSettings('', edition), renew: (current) => renewSettings(current, edition), note: `Claude Code plugins of ${editionLabel(edition)} for this project` },
    { path: '.gitignore', mode: 'append', marker: LOCAL_SETTINGS_PATH, content: `${LOCAL_SETTINGS_PATH}\n`, note: 'machine path of the marketplace stays local' },
  ];
}

export function writeProjectSettings(root, edition) {
  const described = describe(settingsItems(edition), root);
  apply(described, root);
  return described;
}

// ok, missing, broken or drift (with the plugin IDs that differ)
export function settingsStatus(root, edition) {
  const f = path.join(root, SETTINGS_PATH);
  if (!fs.existsSync(f)) return { state: 'missing', wrong: [] };
  const settings = parse(fs.readFileSync(f, 'utf8'));
  if (!settings) return { state: 'broken', wrong: [] };
  const enabled = isObject(settings.enabledPlugins) ? settings.enabledPlugins : {};
  const wrong = Object.entries(projectPlugins(edition)).filter(([id, on]) => enabled[id] !== on).map(([id]) => id);
  return { state: wrong.length ? 'drift' : 'ok', wrong };
}

// User settings of Claude Code, read only: Kette plugins switched on there come from CLI versions before 0.10
export const userSettingsFile = () => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json');

export function userScopePlugins() {
  let settings;
  try { settings = JSON.parse(fs.readFileSync(userSettingsFile(), 'utf8')); } catch { return []; }
  const enabled = isObject(settings?.enabledPlugins) ? settings.enabledPlugins : {};
  return Object.keys(enabled).filter((id) => id.endsWith('@kette') && enabled[id] === true).sort();
}

// Installed bundles to build the marketplace from, Community first so Enterprise wins for plugins both have
export const machineBundles = (installed) => [installed(COMMUNITY) && { tier: COMMUNITY, ...installed(COMMUNITY) }, installed(ENTERPRISE) && { tier: ENTERPRISE, ...installed(ENTERPRISE) }].filter(Boolean);

// The edition plugins in the merged marketplace; an old bundle may still name ui-laws ui-gesetze
function available(edition, plugins) {
  const names = pluginsFor(edition).map((p) => (plugins.includes(p) ? p : Object.keys(RENAMED_PLUGINS).find((old) => RENAMED_PLUGINS[old] === p && plugins.includes(old)) || p));
  return { present: names.filter((p) => plugins.includes(p)), missing: names.filter((p) => !plugins.includes(p)) };
}

// Machine bundles to the merged marketplace, then the edition plugins into the project scope of Claude Code
export function enableProjectPlugins(root, edition, bundles) {
  const market = buildMarketplace(bundles);
  const { present, missing } = available(edition, market.plugins);
  return { ...enablePlugins(market.dir, present, path.resolve(root)), present, missing, dir: market.dir };
}

export function enableHints(result, edition) {
  const lines = [];
  if (!result.ok) lines.push(`Plugins not enabled for this project (${result.reason}). By hand in the project folder:${manualInstall(result.dir, result.present)}`);
  if (result.missing.length) {
    const why = edition === ENTERPRISE ? `the Enterprise bundle is not on this machine. Unlock with: ${cmd('kette login <key>')}` : `the bundles on this machine do not contain them. Reload with: ${cmd('kette update')}`;
    lines.push(`${status('warn', 'WARN')} ${result.missing.join(', ')} not enabled, ${why}`);
  }
  return lines;
}
