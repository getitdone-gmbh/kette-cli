import fs from 'node:fs';
import path from 'node:path';

// Editionen der Kette; free und kette sind die Namen aus Version 0.1.0 und werden beim Lesen übersetzt
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

// Plugins der Edition, die ein älteres Paket auf diesem Rechner noch nicht enthält
export const missingPlugins = (bundleDir, tier) => pluginsFor(tier).filter((p) => !fs.existsSync(path.join(bundleDir, 'plugins', p)));

// Plugins der Edition from, die in to fehlen; beim Wechsel der Edition werden sie entfernt
export const retiredPlugins = (from, to) => pluginsFor(from).filter((p) => !pluginsFor(to).includes(p));

const KINDS = [
  ['agents', 'Agent', 'Agents'],
  ['skills', 'Skill', 'Skills'],
  ['commands', 'Command', 'Commands'],
];
const names = (dir, pick) => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).map(pick).filter(Boolean).sort() : []);

// Agenten, Skills und Befehle eines Plugins, gezählt aus dem Ordner im Paket; null, wenn das Paket das Plugin nicht enthält
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

// Kurzform je Art: bis drei Einträge mit Namen, darüber nur die Anzahl
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

// Vollständige Liste je Plugin für kette doctor
export function pluginDetails(tier, market, bundleDir) {
  return pluginsFor(tier).map((p) => {
    const contents = pluginContents(bundleDir, p);
    const lines = contents ? KINDS.filter(([kind]) => contents[kind].length).map(([kind, , many]) => `${many} (${contents[kind].length}): ${contents[kind].join(', ')}`) : ['not in the bundle'];
    return { id: `${p}@${market}`, lines };
  });
}

// Profil aus 0.1.0 mit tier free oder kette auf die neuen Namen bringen, ohne die Datei zu ändern
export function normalizeProfile(profile) {
  if (!profile || !('tier' in profile)) return profile;
  return { ...profile, tier: normalizeTier(profile.tier) };
}

// true, wenn Version a neuer ist als b (x.y.z, numerisch verglichen)
export function isNewer(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}
