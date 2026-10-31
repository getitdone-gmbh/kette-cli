import fs from 'node:fs';
import path from 'node:path';
import { bundlesDir } from './paths.mjs';
import { COMMUNITY, ENTERPRISE } from './editions.mjs';
import { withLock } from './lock.mjs';
import { isInside } from './files.mjs';

// One Claude Code marketplace per edition, built only from that edition's bundle (docs/adr/0002, decision 8): a plugin ID resolves to
// one copy for every project, so a Community repo must use IDs whose copies come from the Community bundle
export const MARKETS = { [COMMUNITY]: 'kette-community', [ENTERPRISE]: 'kette-enterprise' };
export const marketName = (edition) => MARKETS[edition];
export const marketDir = (edition) => path.join(bundlesDir(), `marketplace-${edition}`);

const STAMP = '.kette-sources.json';
const MANIFEST = path.join('.claude-plugin', 'marketplace.json');
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
export const pluginNames = (dir) => (fs.existsSync(path.join(dir, 'plugins')) ? fs.readdirSync(path.join(dir, 'plugins'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort() : []);

// Copies, not links (Claude Code refuses entries that leave the marketplace folder); a link inside a plugin is resolved,
// one pointing outside the bundle is left out, so nothing from elsewhere on the machine lands in the marketplace
function copyTree(root, from, to) {
  let real;
  try { real = fs.realpathSync(from); } catch { return; }
  if (!isInside(root, real)) return;
  const stat = fs.statSync(real);
  if (stat.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const name of fs.readdirSync(real)) copyTree(root, path.join(from, name), path.join(to, name));
  } else if (stat.isFile()) fs.copyFileSync(real, to);
}

const copyPlugin = (bundleDir, from, to) => copyTree(fs.realpathSync(bundleDir), from, to);

// bundle: { version, dir } of the edition, or null to remove the folder (after kette logout); rebuilt only when the bundle changes
export function buildMarketplace(edition, bundle) {
  const dir = marketDir(edition);
  return withLock(`marketplace-${edition}`, () => {
    if (!bundle) {
      fs.rmSync(dir, { recursive: true, force: true });
      return { dir, plugins: [] };
    }
    const source = { edition, version: bundle.version, dir: path.resolve(bundle.dir) };
    const stamp = JSON.stringify(source);
    if (JSON.stringify(readJson(path.join(dir, STAMP))) === stamp && fs.existsSync(path.join(dir, MANIFEST))) return { dir, plugins: pluginNames(dir) };
    const temp = `${dir}.${process.pid}.tmp`;
    fs.rmSync(temp, { recursive: true, force: true });
    try {
      const listed = readJson(path.join(source.dir, MANIFEST)) || {};
      const entries = pluginNames(source.dir).map((name) => {
        copyPlugin(source.dir, path.join(source.dir, 'plugins', name), path.join(temp, 'plugins', name));
        const entry = listed.plugins?.find((p) => p.name === name) || {};
        return { ...entry, name, source: `./plugins/${name}`, version: entry.version || source.version };
      });
      const manifest = { ...listed, name: marketName(edition), owner: listed.owner || { name: 'Get IT Done GmbH' }, plugins: entries };
      fs.mkdirSync(path.join(temp, '.claude-plugin'), { recursive: true });
      fs.writeFileSync(path.join(temp, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
      fs.writeFileSync(path.join(temp, STAMP), `${stamp}\n`);
      fs.rmSync(dir, { recursive: true, force: true });
      fs.renameSync(temp, dir);
      return { dir, plugins: entries.map((e) => e.name) };
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
}
