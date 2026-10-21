// Editionen der Kette; free und kette sind die Namen aus Version 0.1.0 und werden beim Lesen übersetzt
export const COMMUNITY = 'community';
export const ENTERPRISE = 'enterprise';

const EDITIONS = {
  [COMMUNITY]: { label: 'Community', plugins: ['kette-engineering-core'] },
  [ENTERPRISE]: { label: 'Enterprise (Die Kette)', plugins: ['kette-engineering-core', 'kette-engineering'] },
};
const LEGACY = { free: COMMUNITY, kette: ENTERPRISE };

export const normalizeTier = (tier) => LEGACY[tier] || tier;
export const isLegacyTier = (tier) => tier in LEGACY;
export const editionLabel = (tier) => EDITIONS[normalizeTier(tier)]?.label || String(tier);
export const pluginsFor = (tier) => EDITIONS[normalizeTier(tier)].plugins;

// Skills und Agenten je Plugin, für die Zusammenfassung nach init und add
const PLUGIN_CONTENTS = {
  'kette-engineering-core': ['engineering-rules', 'architecture-patterns'],
  'kette-engineering': ['platform-profile', 'code-reviewer'],
};
export const pluginSummary = (tier, market) => pluginsFor(tier).map((p) => `${p}@${market} (${PLUGIN_CONTENTS[p].join(', ')})`).join(', ');

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
