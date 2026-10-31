import fs from 'node:fs';
import path from 'node:path';
import { marketplaceDir } from './paths.mjs';
import { MARKETPLACE } from './claude.mjs';

// Claude Code keeps one global path per marketplace name, so projects of both editions share one marketplace "kette"
// built from the installed bundles; copies, not links: Claude Code refuses plugin entries that leave the marketplace folder
const STAMP = '.kette-sources.json';
const MANIFEST = path.join('.claude-plugin', 'marketplace.json');

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const pluginNames = (dir) => (fs.existsSync(path.join(dir, 'plugins')) ? fs.readdirSync(path.join(dir, 'plugins'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort() : []);

// bundles: [{ tier, version, dir }] in rising priority, a later bundle wins for a plugin both have (Enterprise over Community)
export function buildMarketplace(bundles) {
  const dir = marketplaceDir();
  const sources = bundles.filter(Boolean).map(({ tier, version, dir: d }) => ({ tier, version, dir: path.resolve(d) }));
  const stamp = JSON.stringify(sources);
  const current = readJson(path.join(dir, STAMP));
  if (current && JSON.stringify(current) === stamp && fs.existsSync(path.join(dir, MANIFEST))) return { dir, plugins: pluginNames(dir) };
  const owner = new Map();
  for (const s of sources) for (const p of pluginNames(s.dir)) owner.set(p, s);
  const temp = `${dir}.${process.pid}.tmp`;
  fs.rmSync(temp, { recursive: true, force: true });
  const entries = [...owner.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, s]) => {
    fs.cpSync(path.join(s.dir, 'plugins', name), path.join(temp, 'plugins', name), { recursive: true });
    const listed = readJson(path.join(s.dir, MANIFEST))?.plugins?.find((p) => p.name === name) || {};
    return { ...listed, name, source: `./plugins/${name}`, version: listed.version || s.version };
  });
  const base = readJson(path.join(sources.at(-1)?.dir || '', MANIFEST)) || {};
  const manifest = { ...base, name: MARKETPLACE, owner: base.owner || { name: 'Get IT Done GmbH' }, plugins: entries };
  fs.mkdirSync(path.join(temp, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(temp, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(path.join(temp, STAMP), `${stamp}\n`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(temp, dir);
  return { dir, plugins: entries.map((e) => e.name) };
}
