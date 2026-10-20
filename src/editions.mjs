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

// Profil aus 0.1.0 mit tier free oder kette auf die neuen Namen bringen, ohne die Datei zu ändern
export function normalizeProfile(profile) {
  if (!profile || !('tier' in profile)) return profile;
  return { ...profile, tier: normalizeTier(profile.tier) };
}
