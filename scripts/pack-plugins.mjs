// Pure checks for scripts/release.mjs: which agent pack plugins each edition needs and whether a pack state has them all

// Every edition plugin that kette-engineering does not ship comes from the agent pack
export const packPluginsFor = (editionPlugins, engPlugins) => editionPlugins.filter((p) => !engPlugins.includes(p));

// Error text when the pack state lacks a needed plugin in its marketplace or as a folder, null when it matches
export function packMismatch({ ref, commit, packPlugins, packDirs, needed, renamed = {} }) {
  const lacking = needed.filter((p) => !packPlugins.includes(p) || !packDirs.includes(p));
  if (!lacking.length) return null;
  const oldNames = lacking.flatMap((p) => Object.keys(renamed).filter((old) => renamed[old] === p && packPlugins.includes(old)).map((old) => `${old} (renamed to ${p})`));
  return [
    `claude-design-agent-pack ${ref} (${commit.slice(0, 7)}) does not match the editions in src/editions.mjs, no bundle built.`,
    `  The pack has: ${packPlugins.join(', ')}`,
    `  The editions need: ${needed.join(', ')}`,
    `  Missing: ${lacking.join(', ')}${oldNames.length ? `; the pack still has the old name ${oldNames.join(', ')}` : ''}`,
    '  Tag a pack release that has these plugins, or set KETTE_AGENT_PACK_REF to such a state for a local test build.',
  ].join('\n');
}
