import fs from 'node:fs';
import path from 'node:path';

// Editions of Die Kette; free and kette are the names from version 0.1.0 and are mapped when read
export const COMMUNITY = 'community';
export const ENTERPRISE = 'enterprise';

const EDITIONS = {
  [COMMUNITY]: { label: 'Community', plugins: ['kette-engineering-core', 'ui-gesetze'] },
  [ENTERPRISE]: { label: 'Enterprise (Die Kette)', plugins: ['kette-engineering-core', 'kette-engineering', 'design-system-agents', 'design-review-pack'] },
};
const LEGACY = { free: COMMUNITY, kette: ENTERPRISE };

export const normalizeTier = (tier) => LEGACY[tier] || tier;
export const isLegacyTier = (tier) => tier in LEGACY;
export const editionLabel = (tier) => EDITIONS[normalizeTier(tier)]?.label || String(tier);
export const pluginsFor = (tier) => EDITIONS[normalizeTier(tier)].plugins;

// Edition plugins that an older bundle on this machine does not contain yet
export const missingPlugins = (bundleDir, tier) => pluginsFor(tier).filter((p) => !fs.existsSync(path.join(bundleDir, 'plugins', p)));

// Plugins of edition from that edition to lacks; they are removed when the edition changes
export const retiredPlugins = (from, to) => pluginsFor(from).filter((p) => !pluginsFor(to).includes(p));

const KINDS = [
  ['agents', 'Agent', 'Agents'],
  ['skills', 'Skill', 'Skills'],
  ['commands', 'Command', 'Commands'],
];
const names = (dir, pick) => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).map(pick).filter(Boolean).sort() : []);

// Agents, skills and commands of a plugin, counted from its folder in the bundle; null when the bundle lacks the plugin
export function pluginContents(bundleDir, plugin) {
  const dir = bundleDir && path.join(bundleDir, 'plugins', plugin);
  if (!dir || !fs.existsSync(dir)) return null;
  const md = (e) => e.isFile() && e.name.endsWith('.md') && e.name.slice(0, -3);
  return {
    agents: names(path.join(dir, 'agents'), md),
    skills: names(path.join(dir, 'skills'), (e) => e.isDirectory() && fs.existsSync(path.join(dir, 'skills', e.name, 'SKILL.md')) && e.name),
    commands: names(path.join(dir, 'commands'), md).map((c) => `/${c}`),
  };
}

// Short form per kind: up to three entries by name, above that only the count
function shortContents(contents) {
  return KINDS.map(([kind, one, many]) => {
    const list = contents[kind];
    if (!list.length) return null;
    if (list.length > 3) return `${list.length} ${many}`;
    return `${list.length === 1 ? one : many} ${list.join(', ')}`;
  }).filter(Boolean).join(', ');
}

export function pluginSummary(tier, market, bundleDir) {
  return pluginsFor(tier).map((p) => {
    const contents = pluginContents(bundleDir, p);
    return contents ? `${p}@${market} (${shortContents(contents)})` : `${p}@${market}`;
  }).join(', ');
}

// Full list per plugin for kette doctor
export function pluginDetails(tier, market, bundleDir) {
  return pluginsFor(tier).map((p) => {
    const contents = pluginContents(bundleDir, p);
    const lines = contents ? KINDS.filter(([kind]) => contents[kind].length).map(([kind, , many]) => `${many} (${contents[kind].length}): ${contents[kind].join(', ')}`) : ['not in the bundle'];
    return { id: `${p}@${market}`, lines };
  });
}

// Map a 0.1.0 profile with tier free or kette to the new names without changing the file
export function normalizeProfile(profile) {
  if (!profile || !('tier' in profile)) return profile;
  return { ...profile, tier: normalizeTier(profile.tier) };
}

// true when version a is newer than b (x.y.z, compared numerically)
export function isNewer(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}
