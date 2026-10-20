// Baut dist/: CLI-Paket, freies Regelwerk-Paket, Manifest, Installer; das Kette-Paket landet in dist/private und wird nie öffentlich gehostet
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const eng = path.resolve(process.env.KETTE_ENGINEERING || path.join(root, '..', 'kette-engineering'));
const dist = path.join(root, 'dist');
const cliVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const sha = execFileSync('git', ['-C', eng, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
const dirty = execFileSync('git', ['-C', eng, 'status', '--porcelain'], { encoding: 'utf8' }).trim();
if (dirty && !process.env.KETTE_ALLOW_DIRTY) throw new Error(`kette-engineering hat offene Änderungen, erst committen:\n${dirty}`);
const count = execFileSync('git', ['-C', eng, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim();
// Semver, damit Claude Code neue Plugin-Versionen erkennt: 0.<Datum>.<Anzahl Commits>
const version = `0.${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.${count}`;

const strip = (s) => s.split('\n').filter((l) => !l.startsWith('// Kopie von')).join('\n');
if (strip(fs.readFileSync(path.join(root, 'src/validate.mjs'), 'utf8')) !== fs.readFileSync(path.join(eng, 'lib/validate.mjs'), 'utf8')) {
  throw new Error('src/validate.mjs weicht von kette-engineering/lib/validate.mjs ab');
}

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(path.join(dist, 'private'), { recursive: true });
// macOS-tar packt sonst Metadaten ein, die GNU tar beim Entpacken als Warnung meldet
const TAR_FLAGS = process.platform === 'darwin' ? ['--no-xattrs', '--no-mac-metadata'] : [];
const hash = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

function pack(name, entries, extra = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kette-'));
  for (const [from, to] of entries) fs.cpSync(path.join(eng, from), path.join(tmp, to), { recursive: true });
  for (const f of fs.readdirSync(path.join(tmp, 'plugins'), { withFileTypes: true }).filter((e) => e.isDirectory())) {
    const pj = path.join(tmp, 'plugins', f.name, '.claude-plugin', 'plugin.json');
    if (fs.existsSync(pj)) fs.writeFileSync(pj, JSON.stringify({ ...JSON.parse(fs.readFileSync(pj, 'utf8')), version }, null, 2) + '\n');
  }
  for (const [to, content] of Object.entries(extra)) { fs.mkdirSync(path.dirname(path.join(tmp, to)), { recursive: true }); fs.writeFileSync(path.join(tmp, to), content); }
  const out = path.join(dist, name);
  execFileSync('tar', [...TAR_FLAGS, '-czf', out, '-C', tmp, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  fs.rmSync(tmp, { recursive: true, force: true });
  return out;
}

const market = JSON.parse(fs.readFileSync(path.join(eng, '.claude-plugin/marketplace.json'), 'utf8'));
const freeMarket = { ...market, version, plugins: market.plugins.filter((p) => p.name === 'kette-engineering-core').map((p) => ({ ...p, version })) };
const fullMarket = { ...market, version, plugins: market.plugins.map((p) => ({ ...p, version })) };

const free = pack(`kette-free-${version}.tgz`, [['rules', 'rules'], ['schema', 'schema'], ['plugins/kette-engineering-core', 'plugins/kette-engineering-core']], {
  '.claude-plugin/marketplace.json': JSON.stringify(freeMarket, null, 2) + '\n',
  'profiles/platform/index.json': fs.readFileSync(path.join(eng, 'profiles/platform/index.json'), 'utf8'),
  'VERSION': version + '\n',
});
const kette = pack(`private/kette-kette-${version}.tgz`, [['rules', 'rules'], ['schema', 'schema'], ['profiles', 'profiles'], ['checks', 'checks'], ['plugins', 'plugins'], ['LICENSE', 'LICENSE']], {
  '.claude-plugin/marketplace.json': JSON.stringify(fullMarket, null, 2) + '\n',
  'VERSION': version + '\n',
});

const cliTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kette-cli-'));
for (const p of ['bin', 'src', 'package.json']) fs.cpSync(path.join(root, p), path.join(cliTmp, p), { recursive: true });
const cli = path.join(dist, `kette-cli-${cliVersion}.tgz`);
execFileSync('tar', [...TAR_FLAGS, '-czf', cli, '-C', cliTmp, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
fs.rmSync(cliTmp, { recursive: true, force: true });

const manifest = {
  version,
  commit: sha,
  cli: { version: cliVersion, url: path.basename(cli), sha256: hash(cli) },
  bundles: { free: { url: path.basename(free), sha256: hash(free) } },
};
fs.writeFileSync(path.join(dist, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
fs.writeFileSync(path.join(dist, 'private', 'kette-bundle.json'), JSON.stringify({ version, url: path.basename(kette), sha256: hash(kette) }, null, 2) + '\n');
for (const f of ['install.sh', 'install.ps1']) fs.copyFileSync(path.join(root, 'install', f), path.join(dist, f));
console.log(`release ${version} · cli ${cliVersion}\n${fs.readdirSync(dist).join('\n')}`);
