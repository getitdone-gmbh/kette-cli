// Baut dist/ lokal: CLI-Paket, Community-Paket, Manifest, Installer; das Enterprise-Paket landet in dist/private und wird nie öffentlich gehostet
// Ohne Option wird nichts veröffentlicht. --publish-enterprise lädt das Enterprise-Paket zusätzlich als Release v<version> in das private Repo alexfriedl/kette-engineering
// Quellen: KETTE_ENGINEERING (Standard ../kette-engineering, Arbeitsstand), KETTE_AGENT_PACK (Standard ../claude-design-agent-pack) mit KETTE_AGENT_PACK_REF (Standard: neuestes Tag v*)
// Ticketing (Enterprise, private, docs/adr/0003): KETTE_TICKETING (default ../kette-ticketing) with KETTE_TICKETING_REF (default: newest tag v*), built from git into ticketing/ of the Enterprise bundle
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ENTERPRISE_REPO = 'alexfriedl/kette-engineering';
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? [path.join(dir, e.name), ...walk(path.join(dir, e.name))] : [path.join(dir, e.name)]));
const publishEnterprise = process.argv.includes('--publish-enterprise');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const eng = path.resolve(process.env.KETTE_ENGINEERING || path.join(root, '..', 'kette-engineering'));
const dist = path.join(root, 'dist');
// Erst in einen Nachbarordner bauen; dist wird nur ersetzt, wenn keine Version mit anderem Inhalt überschrieben würde
const out = path.join(root, '.dist-next');
const cliVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const commit = execFileSync('git', ['-C', eng, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const sha = commit.slice(0, 7);
const dirty = execFileSync('git', ['-C', eng, 'status', '--porcelain'], { encoding: 'utf8' }).trim();
if (dirty && !process.env.KETTE_ALLOW_DIRTY) throw new Error(`kette-engineering hat offene Änderungen, erst committen:\n${dirty}`);
const count = execFileSync('git', ['-C', eng, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim();

// Plugins from claude-design-agent-pack per edition, taken from src/editions.mjs: every edition plugin that kette-engineering does not ship
const { COMMUNITY, ENTERPRISE, RENAMED_PLUGINS, pluginsFor } = await import('../src/editions.mjs');
const engPlugins = JSON.parse(fs.readFileSync(path.join(eng, '.claude-plugin/marketplace.json'), 'utf8')).plugins.map((p) => p.name);
const { packMismatch, packPluginsFor } = await import('./pack-plugins.mjs');
const COMMUNITY_PACK_PLUGINS = packPluginsFor(pluginsFor(COMMUNITY), engPlugins);
const { PART_FILES, TICKETING_PLUGIN, forbiddenIn, marketEntry, writePlugin } = await import('./ticketing-part.mjs');
// kette-ticketing builds its plugin itself (agent kette-intake, command /intake), it never comes from the agent pack
const ENTERPRISE_PACK_PLUGINS = packPluginsFor(pluginsFor(ENTERPRISE), [...engPlugins, TICKETING_PLUGIN]);
const agentPack = path.resolve(process.env.KETTE_AGENT_PACK || path.join(root, '..', 'claude-design-agent-pack'));
const newestTag = (repo) => execFileSync('git', ['-C', repo, 'tag', '--list', 'v*', '--sort=-v:refname'], { encoding: 'utf8' }).split('\n').find((tag) => /^v\d+\.\d+\.\d+$/.test(tag)) || '';
const agentPackRef = process.env.KETTE_AGENT_PACK_REF || newestTag(agentPack);
if (!agentPackRef) throw new Error(`claude-design-agent-pack (${agentPack}) hat kein Tag vX.Y.Z, KETTE_AGENT_PACK_REF setzen`);
const agentPackCommit = execFileSync('git', ['-C', agentPack, 'rev-parse', `${agentPackRef}^{commit}`], { encoding: 'utf8' }).trim();
const agentPackTagged = execFileSync('git', ['-C', agentPack, 'tag', '--points-at', agentPackCommit], { encoding: 'utf8' }).trim() !== '';
const packCount = execFileSync('git', ['-C', agentPack, 'rev-list', '--count', agentPackCommit], { encoding: 'utf8' }).trim();
// The pack state must have every plugin the editions install, otherwise a bundle would ship without it (e.g. tag v1.2.2 still has ui-gesetze, the editions need ui-laws)
const packPlugins = JSON.parse(execFileSync('git', ['-C', agentPack, 'show', `${agentPackCommit}:.claude-plugin/marketplace.json`], { encoding: 'utf8' })).plugins.map((p) => p.name);
const packDirs = execFileSync('git', ['-C', agentPack, 'ls-tree', '--name-only', agentPackCommit, 'plugins/'], { encoding: 'utf8' }).split('\n').filter(Boolean).map((d) => d.replace(/^plugins\//, ''));
const mismatch = packMismatch({ ref: agentPackRef, commit: agentPackCommit, packPlugins, packDirs, needed: [...new Set([...COMMUNITY_PACK_PLUGINS, ...ENTERPRISE_PACK_PLUGINS])], renamed: RENAMED_PLUGINS });
if (mismatch) throw new Error(mismatch);
// Ticketing at a pinned ref: like the agent pack, the git state is packed, never the working folder
const ticketingRepo = path.resolve(process.env.KETTE_TICKETING || path.join(root, '..', 'kette-ticketing'));
const ticketingRef = process.env.KETTE_TICKETING_REF || newestTag(ticketingRepo);
if (!ticketingRef) throw new Error(`kette-ticketing (${ticketingRepo}) has no tag vX.Y.Z, set KETTE_TICKETING_REF`);
const ticketingCommit = execFileSync('git', ['-C', ticketingRepo, 'rev-parse', `${ticketingRef}^{commit}`], { encoding: 'utf8' }).trim();
const ticketingTagged = execFileSync('git', ['-C', ticketingRepo, 'tag', '--points-at', ticketingCommit], { encoding: 'utf8' }).trim() !== '';
const ticketingCount = execFileSync('git', ['-C', ticketingRepo, 'rev-list', '--count', ticketingCommit], { encoding: 'utf8' }).trim();
// Semver, damit Claude Code neue Plugin-Versionen erkennt: 0.<Datum>.<Commits kette-engineering plus Commits Agenten-Pack>; ein neuer Stand in einem der beiden Repos ergibt eine neue Version
const version = `0.${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.${Number(count) + Number(packCount) + Number(ticketingCount)}`;
// Feste Zeit für alle Dateien im Paket (jüngerer der beiden Commits), damit gleicher Inhalt dieselbe Prüfsumme ergibt
const commitTime = (repo, ref) => Number(execFileSync('git', ['-C', repo, 'log', '-1', '--format=%ct', ref], { encoding: 'utf8' }).trim());
const sourceTime = new Date(Math.max(commitTime(eng, 'HEAD'), commitTime(agentPack, agentPackCommit), commitTime(ticketingRepo, ticketingCommit)) * 1000);

const strip = (s) => s.split('\n').filter((l) => !l.startsWith('// Kopie von')).join('\n');
for (const lib of ['validate.mjs', 'templates.mjs']) {
  if (strip(fs.readFileSync(path.join(root, 'src', lib), 'utf8')) !== fs.readFileSync(path.join(eng, 'lib', lib), 'utf8')) {
    throw new Error(`src/${lib} differs from kette-engineering/lib/${lib}`);
  }
}

// CLI 0.5.x copies the flat files, CLI 0.6 renders from render/; both sets must be in the Enterprise bundle until 2027-01-31
const LEGACY_SET = [
  ...['DEPLOY.md', 'Dockerfile.api', 'Dockerfile.web', 'ci.yml', 'compose.yaml', 'deploy.yml', 'playwright.config.ts', 'prune-runtime.mjs'].map((f) => `profiles/platform/github-docker/templates/${f}`),
  ...['tsconfig.strict.json', 'eslint.config.mjs', 'dependency-cruiser.cjs', 'gitleaks.toml'].map((f) => `checks/${f}`),
  'rules/architecture/adr-vorlage.md',
];
const RENDER_SET = ['checks/render/index.json', 'profiles/platform/github-docker/render/index.json', 'rules/architecture/adr-template.md'];
const missingSet = [...LEGACY_SET, ...RENDER_SET].filter((f) => !fs.existsSync(path.join(eng, f)));
if (missingSet.length) throw new Error(`kette-engineering is missing template files for CLI 0.5.x or 0.6: ${missingSet.join(', ')}`);

// detect.mjs filters app folders with its own copy of the schema pattern; both must stay the same rule
const { APP_FOLDER_PATTERN } = await import('../src/detect.mjs');
const schemaApps = JSON.parse(fs.readFileSync(path.join(eng, 'schema', 'profile.schema.json'), 'utf8')).properties.apps.properties;
const drifted = Object.entries(schemaApps).filter(([, entry]) => entry.pattern !== APP_FOLDER_PATTERN).map(([stack]) => stack);
if (drifted.length) throw new Error(`APP_FOLDER in src/detect.mjs differs from the apps pattern in the schema (${drifted.join(', ')})`);

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'private'), { recursive: true });

// Stand aus Git statt Arbeitsordner, damit offene Änderungen oder ein anderer Branch im Agenten-Pack nicht mitgepackt werden
const packSrc = fs.mkdtempSync(path.join(os.tmpdir(), 'kette-agent-pack-'));
const archive = execFileSync('git', ['-C', agentPack, 'archive', '--format=tar', agentPackCommit, '.claude-plugin/marketplace.json', ...[...COMMUNITY_PACK_PLUGINS, ...ENTERPRISE_PACK_PLUGINS].map((p) => `plugins/${p}`)], { maxBuffer: 1 << 30 });
execFileSync('tar', ['-x', '-C', packSrc], { input: archive });
// In der Kette heißt der Marketplace kette; Installationshinweise in den Plugin-Texten entsprechend umschreiben
for (const f of walk(path.join(packSrc, 'plugins')).filter((f) => f.endsWith('.md'))) {
  const text = fs.readFileSync(f, 'utf8');
  if (text.includes('@claude-design-agent-pack')) fs.writeFileSync(f, text.replaceAll('@claude-design-agent-pack', '@kette'));
}
// Ticketing is TypeScript: built from the archive of its ref; only what the CLI loads ships, never the backfill data of Get IT Done
const ticketingSrc = fs.mkdtempSync(path.join(os.tmpdir(), 'kette-ticketing-'));
execFileSync('tar', ['-x', '-C', ticketingSrc], { input: execFileSync('git', ['-C', ticketingRepo, 'archive', '--format=tar', ticketingCommit], { maxBuffer: 1 << 30 }) });
execFileSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: ticketingSrc, stdio: 'inherit', shell: process.platform === 'win32' });
execFileSync('npm', ['run', 'build'], { cwd: ticketingSrc, stdio: 'inherit', shell: process.platform === 'win32' });
const { CONTRACT, ENTRY } = await import('../src/ticket/module.mjs');
const { CLI_CONTRACT } = await import(pathToFileURL(path.join(ticketingSrc, ENTRY)).href);
if (CLI_CONTRACT !== CONTRACT) throw new Error(`kette-ticketing ${ticketingRef} speaks contract ${CLI_CONTRACT}, this CLI ${CONTRACT}`);
// What ships is staged first and checked: a repo, session name, Figma key, private address or the Spark in it stops the release
const ticketingStage = fs.mkdtempSync(path.join(os.tmpdir(), 'kette-ticketing-stage-'));
for (const p of PART_FILES) fs.cpSync(path.join(ticketingSrc, p), path.join(ticketingStage, 'ticketing', p), { recursive: true });
writePlugin(ticketingSrc, path.join(ticketingStage, 'plugin'), version);
const internal = forbiddenIn(ticketingStage);
if (internal.length) throw new Error(`kette-ticketing ${ticketingRef} would ship internal content, nothing was packed:\n  ${internal.join('\n  ')}`);
const fromTicketing = [[path.join(ticketingStage, 'ticketing'), 'ticketing'], [path.join(ticketingStage, 'plugin'), `plugins/${TICKETING_PLUGIN}`]];
const fromEng = (p) => path.join(eng, p);
const fromPack = (name) => [path.join(packSrc, 'plugins', name), `plugins/${name}`];
// macOS-tar packt sonst Metadaten ein, die GNU tar beim Entpacken als Warnung meldet; Besitzer immer 0, damit das Paket nicht vom Rechner abhängt
const TAR_FLAGS = process.platform === 'darwin'
  ? ['--no-xattrs', '--no-mac-metadata', '--uid', '0', '--gid', '0', '--uname', '', '--gname', '']
  : ['--owner=0', '--group=0', '--numeric-owner'];
const hash = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

// Packt dir reproduzierbar nach file: feste Zeit, sortierte Einträge, gzip ohne Zeitstempel
function tarball(dir, file, time = sourceTime) {
  fs.chmodSync(dir, 0o755);
  const entries = ['.', ...walk(dir).map((f) => `./${path.relative(dir, f).split(path.sep).join('/')}`).sort()];
  for (const e of entries) fs.utimesSync(path.join(dir, e), time, time);
  const tar = execFileSync('tar', [...TAR_FLAGS, '--no-recursion', '-cf', '-', '-C', dir, '-T', '-'], { input: entries.join('\n') + '\n', maxBuffer: 1 << 30, env: { ...process.env, COPYFILE_DISABLE: '1' } });
  const gz = zlib.gzipSync(tar, { level: 9 });
  // Byte 9 im gzip-Kopf nennt das Betriebssystem; fest auf 255 (unbekannt), damit macOS und Linux dieselben Bytes liefern
  gz[9] = 255;
  fs.writeFileSync(file, gz);
}

function pack(name, entries, extra = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kette-'));
  for (const [from, to] of entries) fs.cpSync(from, path.join(tmp, to), { recursive: true });
  for (const f of fs.readdirSync(path.join(tmp, 'plugins'), { withFileTypes: true }).filter((e) => e.isDirectory())) {
    const pj = path.join(tmp, 'plugins', f.name, '.claude-plugin', 'plugin.json');
    if (fs.existsSync(pj)) fs.writeFileSync(pj, JSON.stringify({ ...JSON.parse(fs.readFileSync(pj, 'utf8')), version }, null, 2) + '\n');
  }
  for (const [to, content] of Object.entries(extra)) { fs.mkdirSync(path.dirname(path.join(tmp, to)), { recursive: true }); fs.writeFileSync(path.join(tmp, to), content); }
  const file = path.join(out, name);
  tarball(tmp, file);
  fs.rmSync(tmp, { recursive: true, force: true });
  return file;
}

// Ausgelieferte Pakete heißen in Claude Code "kette", der Entwickler-Marketplace auf das Repo behält "kette-engineering"
const market = { ...JSON.parse(fs.readFileSync(path.join(eng, '.claude-plugin/marketplace.json'), 'utf8')), name: 'kette' };
const packMarket = JSON.parse(fs.readFileSync(path.join(packSrc, '.claude-plugin/marketplace.json'), 'utf8'));
const packEntries = (names) => names.map((name) => {
  const entry = packMarket.plugins.find((p) => p.name === name);
  if (!entry) throw new Error(`Plugin ${name} fehlt in claude-design-agent-pack ${agentPackRef}`);
  return { ...entry, source: `./plugins/${name}` };
});
const withVersion = (plugins) => plugins.map((p) => ({ ...p, version }));
const communityMarket = { ...market, version, plugins: withVersion([...market.plugins.filter((p) => p.name === 'kette-engineering-core'), ...packEntries(COMMUNITY_PACK_PLUGINS)]) };
const enterpriseMarket = { ...market, version, plugins: withVersion([...market.plugins, ...packEntries(ENTERPRISE_PACK_PLUGINS), marketEntry(version)]) };

const community = pack(`kette-community-${version}.tgz`, [[fromEng('rules'), 'rules'], [fromEng('schema'), 'schema'], [fromEng('plugins/kette-engineering-core'), 'plugins/kette-engineering-core'], ...COMMUNITY_PACK_PLUGINS.map(fromPack)], {
  '.claude-plugin/marketplace.json': JSON.stringify(communityMarket, null, 2) + '\n',
  'profiles/platform/index.json': fs.readFileSync(path.join(eng, 'profiles/platform/index.json'), 'utf8'),
  // Names of the Enterprise stack profiles, so kette rules <stack> in Community points to kette login
  'profiles/stack/index.json': fs.readFileSync(path.join(eng, 'profiles/stack/index.json'), 'utf8'),
  'VERSION': version + '\n',
});
const enterprise = pack(`private/kette-enterprise-${version}.tgz`, [...['rules', 'schema', 'profiles', 'checks', 'plugins', 'LICENSE'].map((p) => [fromEng(p), p]), ...ENTERPRISE_PACK_PLUGINS.map(fromPack), ...fromTicketing], {
  '.claude-plugin/marketplace.json': JSON.stringify(enterpriseMarket, null, 2) + '\n',
  'VERSION': version + '\n',
});
fs.rmSync(packSrc, { recursive: true, force: true });
fs.rmSync(ticketingSrc, { recursive: true, force: true });
fs.rmSync(ticketingStage, { recursive: true, force: true });

const cliTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kette-cli-'));
for (const p of ['bin', 'src', 'package.json', 'LICENSE']) fs.cpSync(path.join(root, p), path.join(cliTmp, p), { recursive: true });
const cli = path.join(out, `kette-cli-${cliVersion}.tgz`);
// Das CLI-Paket trägt die Zeit seines eigenen Commits, damit ein neues Regelwerk die CLI-Prüfsumme nicht ändert
tarball(cliTmp, cli, new Date(commitTime(root, 'HEAD') * 1000));
fs.rmSync(cliTmp, { recursive: true, force: true });

const manifest = {
  version,
  commit: sha,
  cli: { version: cliVersion, url: path.basename(cli), sha256: hash(cli) },
  bundles: { community: { url: path.basename(community), sha256: hash(community) } },
};
const enterpriseMeta = { version, sha256: hash(enterprise), published_at: new Date().toISOString(), agent_pack: { ref: agentPackRef, commit: agentPackCommit.slice(0, 7) }, ticketing: { ref: ticketingRef, commit: ticketingCommit.slice(0, 7) } };

// Gleiche Version mit anderem Inhalt würde ein schon gebautes oder verteiltes Paket ersetzen, ohne dass Claude Code es bemerkt
const readJson = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null);
const before = { community: readJson(path.join(dist, 'manifest.json')), enterprise: readJson(path.join(dist, 'private', 'kette-enterprise.json')) };
const clash = [
  before.community?.version === version && before.community.bundles?.community?.sha256 !== manifest.bundles.community.sha256 && `Community-Paket ${version}`,
  before.enterprise?.version === version && before.enterprise.sha256 !== enterpriseMeta.sha256 && `Enterprise-Paket ${version}`,
  before.community?.cli?.version === cliVersion && before.community.cli.sha256 !== manifest.cli.sha256 && `CLI ${cliVersion}`,
].filter(Boolean);
if (clash.length) {
  fs.rmSync(out, { recursive: true, force: true });
  throw new Error(`dist enthält schon dieselbe Version mit anderem Inhalt: ${clash.join(', ')}. Erst committen (bei der CLI die Version in package.json erhöhen), damit eine neue Version entsteht, oder dist bewusst löschen.`);
}

fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
fs.writeFileSync(path.join(out, 'private', 'kette-enterprise.json'), JSON.stringify(enterpriseMeta, null, 2) + '\n');
for (const f of ['install.sh', 'install.ps1']) fs.copyFileSync(path.join(root, 'install', f), path.join(out, f));
fs.rmSync(dist, { recursive: true, force: true });
fs.renameSync(out, dist);
const enterpriseFile = path.join(dist, 'private', path.basename(enterprise));
const enterpriseInfo = path.join(dist, 'private', 'kette-enterprise.json');
console.log(`release ${version} · cli ${cliVersion} · claude-design-agent-pack ${agentPackRef} (${agentPackCommit.slice(0, 7)}) · kette-ticketing ${ticketingRef} (${ticketingCommit.slice(0, 7)})\n${fs.readdirSync(dist).join('\n')}\nprivate/${fs.readdirSync(path.join(dist, 'private')).join('\nprivate/')}`);

// Release-Argumente für gh; das Enterprise-Paket geht nur in ein privates Repo
const releaseArgs = ['release', 'create', `v${version}`, enterpriseFile, enterpriseInfo, '--repo', ENTERPRISE_REPO, '--target', commit, '--title', `v${version}`, '--notes', `Enterprise-Paket ${version} (kette-engineering ${sha}, claude-design-agent-pack ${agentPackRef}, kette-ticketing ${ticketingRef})`];
if (publishEnterprise) {
  if (dirty) throw new Error('Mit offenen Änderungen in kette-engineering wird nichts veröffentlicht');
  if (!agentPackTagged) throw new Error(`claude-design-agent-pack ${agentPackRef} ist kein Release-Tag, veröffentlicht wird nur ein getaggter Stand`);
  if (!ticketingTagged) throw new Error(`kette-ticketing ${ticketingRef} is no release tag, only a tagged state is published`);
  if (!execFileSync('git', ['-C', eng, 'branch', '-r', '--contains', commit], { encoding: 'utf8' }).trim()) throw new Error(`kette-engineering ${sha} ist noch nicht gepusht, das Release-Tag braucht den Commit auf GitHub`);
  const visibility = JSON.parse(execFileSync('gh', ['repo', 'view', ENTERPRISE_REPO, '--json', 'isPrivate'], { encoding: 'utf8' }));
  if (!visibility.isPrivate) throw new Error(`${ENTERPRISE_REPO} ist nicht privat, das Enterprise-Paket wird dort nicht veröffentlicht`);
  execFileSync('gh', releaseArgs, { stdio: 'inherit' });
  console.log(`Enterprise ${version} veröffentlicht in ${ENTERPRISE_REPO} (Release v${version})`);
} else {
  console.log(`\nEnterprise veröffentlichen mit: npm run release -- --publish-enterprise\n  gh ${releaseArgs.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`);
}
