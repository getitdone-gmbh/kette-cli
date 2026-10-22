import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { capture, fakeBundle, json, serve, sha256, tmp, write } from './helpers.mjs';
import { main } from '../src/cli.mjs';
import { BLOCK_START } from '../src/npmrc.mjs';

const KEY = 'CDP-AAAAA-BBBBB-CCCCC-00001';
const V = '0.20261020.9';
// mit den Prüfungen, die kette add in Enterprise-Projekte kopiert
const checks = Object.fromEntries(['tsconfig.strict.json', 'eslint.config.mjs', 'dependency-cruiser.cjs', 'gitleaks.toml'].map((f) => [`checks/${f}`, '{}\n']));
const bundle = fakeBundle(V, undefined, checks);
const token = (c) => `kt_${c.repeat(43)}`;
const figmaFiles = { 'Design-Tokens.fig': 'tokens-fig', 'zero.fig': 'zero-fig', 'IMPORT.md': '# Import\n' };
const calls = [];
const state = { minted: 0, valid: new Set(), ci: [], badFigma: false, registryDown: false, dormant: false };
let server;
let registry;

before(async () => {
  server = await serve((req, res, body) => {
    const url = new URL(req.url, server.url);
    const b = body ? JSON.parse(body) : {};
    calls.push({ method: req.method, path: url.pathname, body: b });
    // Lieferdienst vor dem Go-live der Registry und der Figma-Lieferung
    if (state.dormant && url.pathname.startsWith('/registry/')) return json(res, 503, { error: 'registry_not_configured', message: 'registry not configured' });
    if (state.dormant && url.pathname.startsWith('/figma/')) return json(res, 503, { error: 'figma_not_configured', message: 'figma not configured' });
    if (url.pathname === '/install/token') return json(res, 200, { edition: 'enterprise', version: V, url: `${server.url}/install/download/x`, sha256: bundle.sha256, expires_at: '2027-10-20T00:00:00Z', updates_until: '2027-10-20T00:00:00Z', seats: { used: 1, max: 3 } });
    if (url.pathname === '/install/latest') return json(res, 200, { version: V, available: V, updates_until: '2027-10-20T00:00:00Z' });
    if (url.pathname === '/install/download/x') { res.writeHead(200); return res.end(bundle.buf); }
    if (url.pathname === '/registry/token') {
      if (state.registryDown) return json(res, 503, { error: 'unavailable' });
      const t = token(String.fromCharCode(97 + (state.minted++ % 26)));
      state.valid.add(t);
      return json(res, 200, { token: t, registry, scope: '@getitdone-gmbh', kind: 'device' });
    }
    if (url.pathname === '/registry/token/revoke') { state.valid.clear(); return json(res, 200, { revoked: true }); }
    if (url.pathname === '/-/whoami') return state.valid.has((req.headers.authorization || '').slice(7)) ? json(res, 200, { username: 'kette-1' }) : json(res, 401, { error: 'unauthorized' });
    if (url.pathname === '/registry/ci-tokens/create') {
      if (state.ci.length >= 2) return json(res, 429, { error: 'ci_token_limit', used: 2, max: 2 });
      const t = { id: `00000000-0000-4000-8000-00000000000${state.ci.length}`, label: b.label, token: token('Z'), prefix: 'kt_ZZZZZZZ', created_at: '2026-10-21T10:00:00Z', last_used_at: null };
      state.ci.push(t);
      return json(res, 200, { id: t.id, token: t.token, label: t.label, registry, kind: 'ci' });
    }
    if (url.pathname === '/registry/ci-tokens/list') return json(res, 200, { tokens: state.ci.map(({ token: _t, ...rest }) => rest), max: 2 });
    if (url.pathname === '/registry/ci-tokens/revoke') {
      const before = state.ci.length;
      state.ci = state.ci.filter((t) => t.id !== b.id);
      return json(res, 200, { revoked: state.ci.length < before });
    }
    if (url.pathname === '/figma/links') {
      return json(res, 200, {
        version: '2026.11.30',
        updates_until: '2027-10-20T00:00:00Z',
        guide_url: `${server.url}/figma/download/IMPORT.md`,
        files: Object.entries(figmaFiles).map(([name, c]) => ({ name, title: name, size: c.length, sha256: state.badFigma ? '0'.repeat(64) : sha256(Buffer.from(c)), url: `${server.url}/figma/download/${name}`, expires_at: '2026-10-21T10:15:00Z' })),
      });
    }
    const fig = url.pathname.match(/^\/figma\/download\/(.+)$/);
    if (fig) { res.writeHead(200); return res.end(figmaFiles[fig[1]]); }
    return json(res, 404, { error: 'not_found' });
  });
  registry = `${server.url}/`;
  process.env.KETTE_DELIVERY = server.url;
});
after(() => server.close());

let kh;
let userrc;
beforeEach(() => {
  kh = tmp();
  process.env.KETTE_HOME = kh;
  userrc = path.join(tmp(), 'user.npmrc');
  process.env.NPM_CONFIG_USERCONFIG = userrc;
  calls.length = 0;
  Object.assign(state, { minted: 0, valid: new Set(), ci: [], badFigma: false, registryDown: false, dormant: false });
});

const run = (...argv) => capture(() => main(argv));
const rc = () => fs.readFileSync(userrc, 'utf8');
const inDir = async (dir, fn) => {
  const cwd = process.cwd();
  process.chdir(dir);
  try { return await fn(); } finally { process.chdir(cwd); }
};

test('login richtet den npm-Zugang als Block mit Rechten 600 ein, nach dem Registrieren des Geräts', async () => {
  write(path.dirname(userrc), 'user.npmrc', 'save-exact=true\n');
  const { result, out } = await run('login', KEY, '--no-plugins');
  assert.equal(result, 0);
  assert.match(out, /npm-Zugang eingerichtet: @getitdone-gmbh über 127\.0\.0\.1:\d+/);
  const host = registry.replace('http:', '');
  assert.equal(rc(), `save-exact=true\n\n${BLOCK_START}\n@getitdone-gmbh:registry=${registry}\n${host}:_authToken=${token('a')}\n# <<< kette\n`);
  if (process.platform !== 'win32') assert.equal(fs.statSync(userrc).mode & 0o777, 0o600);
  const order = calls.map((c) => c.path);
  assert.ok(order.indexOf('/install/token') < order.indexOf('/registry/token'));
  const device = fs.readFileSync(path.join(kh, 'device-id'), 'utf8').trim();
  assert.deepEqual(calls.find((c) => c.path === '/registry/token').body, { key: KEY, device });
  assert.ok(!out.includes(token('a')), 'der Token wird nicht ausgegeben');
});

test('eine fremde @getitdone-gmbh-Zeile bleibt unangetastet, --npm-replace stellt um und logout stellt sie wieder her', async () => {
  const dev = '@getitdone-gmbh:registry=https://npm.pkg.github.com\n';
  write(path.dirname(userrc), 'user.npmrc', dev);
  const { out } = await run('login', KEY, '--no-plugins');
  assert.match(out, /enthält schon @getitdone-gmbh:registry=https:\/\/npm\.pkg\.github\.com.*bleibt unverändert/s);
  assert.match(out, /--npm-replace/);
  assert.equal(rc(), dev);
  assert.ok(!calls.some((c) => c.path === '/registry/token'), 'kein Token ohne Ziel');

  await run('login', KEY, '--no-plugins', '--npm-replace');
  assert.match(rc(), /^# kette login hat deaktiviert: @getitdone-gmbh/m);
  await run('logout', '--no-plugins');
  assert.equal(rc(), dev);
});

test('logout widerruft den Token und entfernt nur den Block, eine nur von kette angelegte Datei verschwindet', async () => {
  write(path.dirname(userrc), 'user.npmrc', 'fund=false\r\n');
  await run('login', KEY, '--no-plugins');
  const { out } = await run('logout', '--no-plugins');
  assert.match(out, /npm-Zugang entfernt/);
  assert.equal(rc(), 'fund=false\r\n');
  assert.deepEqual(calls.at(-1).body, { key: KEY, device: fs.readFileSync(path.join(kh, 'device-id'), 'utf8').trim() });
  assert.equal(calls.at(-1).path, '/registry/token/revoke');

  fs.rmSync(userrc);
  await run('login', KEY, '--no-plugins');
  await run('logout', '--no-plugins');
  assert.equal(fs.existsSync(userrc), false);
});

test('logout ohne Netz entfernt den Block trotzdem', async () => {
  await run('login', KEY, '--no-plugins');
  process.env.KETTE_DELIVERY = 'http://127.0.0.1:1';
  try {
    const { out } = await run('logout', '--no-plugins');
    assert.match(out, /npm-Token nicht widerrufen.*Block wird trotzdem entfernt/s);
    assert.equal(fs.existsSync(userrc), false);
  } finally {
    process.env.KETTE_DELIVERY = server.url;
  }
});

test('--no-npm überspringt den Schritt, ein Fehler des Lieferdienstes bricht den Login nicht ab, update holt ihn nach', async () => {
  assert.match((await run('login', KEY, '--no-plugins', '--no-npm')).out, /npm-Zugang übersprungen/);
  assert.equal(fs.existsSync(userrc), false);
  state.registryDown = true;
  const down = await run('login', KEY, '--no-plugins');
  assert.equal(down.result, 0);
  assert.match(down.out, /npm-Zugang nicht eingerichtet: Der Lieferdienst kann.*kette update/s);
  state.registryDown = false;
  assert.match((await run('update', '--no-plugins')).out, /npm-Zugang fehlt, richte ihn ein/);
  assert.equal(state.valid.size, 1);
});

test('update stellt ein neues Token aus, wenn die Registry das alte ablehnt, und lässt ein gültiges in Ruhe', async () => {
  await run('login', KEY, '--no-plugins');
  assert.doesNotMatch((await run('update', '--no-plugins')).out, /npm-/);
  state.valid.clear();
  const { out } = await run('update', '--no-plugins');
  assert.match(out, /npm-Token wird nicht mehr angenommen, stelle ein neues aus/);
  assert.match(rc(), new RegExp(token('b')));
});

test('token ci create, list und revoke', async () => {
  await run('login', KEY, '--no-plugins');
  const created = await run('token', 'ci', 'create', 'GitHub Actions');
  assert.match(created.out, new RegExp(`Es wird nur jetzt angezeigt:\\n\\n  ${token('Z')}`));
  assert.match(created.out, /registry-url: http:\/\/127\.0\.0\.1:\d+\/, scope: '@getitdone-gmbh'/);
  assert.match(created.out, /NODE_AUTH_TOKEN: \$\{\{ secrets\.KETTE_NPM_TOKEN \}\}/);
  assert.match(created.out, /npm config set \/\/127\.0\.0\.1:\d+\/:_authToken "\$KETTE_NPM_TOKEN"/);
  await run('token', 'ci', 'create', 'gitlab');
  await assert.rejects(run('token', 'ci', 'create', 'third'), /2 von 2 CI-Tokens.*kette token ci revoke/);
  const list = await run('token', 'ci', 'list');
  assert.match(list.out, /CI-Tokens: 2 von 2/);
  assert.ok(!list.out.includes(token('Z')));
  assert.match((await run('token', 'ci', 'revoke', state.ci[0].id)).out, /widerrufen/);
  assert.match((await run('token', 'ci', 'revoke', '00000000-0000-4000-8000-000000000009')).out, /Kein aktives CI-Token/);
  await assert.rejects(run('token', 'npm', 'list'), /kette token ci/);
});

test('token ci und figma verlangen einen Login', async () => {
  await assert.rejects(run('token', 'ci', 'list'), /Nicht angemeldet/);
  await assert.rejects(run('figma'), /Nicht angemeldet/);
});

test('figma lädt alle Dateien mit Prüfsumme in den Zielordner und nennt die Import-Reihenfolge', async () => {
  await run('login', KEY, '--no-plugins');
  const out = path.join(tmp(), 'figma');
  const r = await run('figma', '--out', out);
  assert.equal(r.result, 0);
  assert.deepEqual(fs.readdirSync(out).sort(), ['Design-Tokens.fig', 'IMPORT.md', 'zero.fig']);
  assert.equal(fs.readFileSync(path.join(out, 'zero.fig'), 'utf8'), 'zero-fig');
  assert.match(r.out, /Figma-Release 2026\.11\.30/);
  assert.match(r.out, /1\. Design-Tokens\.fig importieren.*2\. GetITDone-Basic\.fig.*3\. zero\.fig/s);
  assert.match(r.out, /Professional oder höher/);

  const project = tmp();
  await inDir(project, () => run('figma'));
  assert.ok(fs.existsSync(path.join(project, 'kette-figma-2026.11.30', 'IMPORT.md')), 'ohne --out ein Ordner mit der Version');

  state.badFigma = true;
  await assert.rejects(run('figma', '--out', path.join(tmp(), 'bad')), /Prüfsumme von Design-Tokens\.fig stimmt nicht/);
});

test('add schreibt nur die Scope-Zeile ohne Token in die Projekt-.npmrc und lässt eine vorhandene Zeile stehen', async () => {
  await run('login', KEY, '--no-plugins');
  const project = tmp();
  write(project, 'package.json', '{}');
  await inDir(project, () => run('add', '--yes', '--no-plugins', '--stack', 'nextjs-ts-tailwind', '--platform', 'github-docker', '--patterns', 'modular-monolith'));
  assert.equal(fs.readFileSync(path.join(project, '.npmrc'), 'utf8'), `@getitdone-gmbh:registry=${registry}\n`);

  const dev = tmp();
  write(dev, 'package.json', '{}');
  write(dev, '.npmrc', '@getitdone-gmbh:registry=https://npm.pkg.github.com\n');
  await inDir(dev, () => run('add', '--yes', '--no-plugins', '--stack', 'nextjs-ts-tailwind', '--platform', 'github-docker', '--patterns', 'modular-monolith'));
  assert.equal(fs.readFileSync(path.join(dev, '.npmrc'), 'utf8'), '@getitdone-gmbh:registry=https://npm.pkg.github.com\n');
  const { out } = await inDir(dev, () => run('doctor', '--ci'));
  assert.match(out, /HINW  \.npmrc im Projekt zeigt @getitdone-gmbh auf npm\.pkg\.github\.com/);
});

test('doctor prüft Block und Token und findet einen Token in einer Datei im Git', async () => {
  await run('login', KEY, '--no-plugins');
  const project = tmp();
  write(project, 'package.json', '{}');
  await inDir(project, () => run('add', '--yes', '--no-plugins', '--stack', 'nextjs-ts-tailwind', '--platform', 'github-docker', '--patterns', 'modular-monolith'));
  execFileSync('git', ['-C', project, 'init', '-q']);
  execFileSync('git', ['-C', project, 'add', '.']);
  let { out } = await inDir(project, () => run('doctor'));
  assert.match(out, /OK {4}npm-Zugang in /);
  assert.match(out, /OK {4}npm-Token gültig/);
  assert.match(out, /OK {4}kein npm-Token in Dateien im Git/);

  write(project, 'ci/.npmrc', `//npm.kette.itdone.de/:_authToken=${token('q')}\n`);
  execFileSync('git', ['-C', project, 'add', '.']);
  state.valid.clear();
  ({ out } = await inDir(project, () => run('doctor')));
  assert.match(out, /FEHLT npm-Token gültig \(Antwort 401, neu ausstellen mit: kette update\)/);
  assert.match(out, /FEHLT npm-Token in Dateien im Git: ci\/\.npmrc/);
});

test('Registry noch nicht eingerichtet: login gelingt mit einer Zeile, kein npmrc-Block, keine Projekt-Zeile, update und logout bleiben still', async () => {
  state.dormant = true;
  write(path.dirname(userrc), 'user.npmrc', 'save-exact=true\n');
  const { result, out } = await run('login', KEY, '--no-plugins');
  assert.equal(result, 0);
  assert.equal(out.split('\n').filter((l) => /npm/i.test(l)).join('\n'), 'npm-Paketzugang folgt mit dem Update bis 30.11.2026');
  assert.match(out, /Angemeldet: .*Updates bis/);
  assert.equal(rc(), 'save-exact=true\n', 'kein Block in der Benutzer-npmrc');

  const project = tmp();
  write(project, 'package.json', '{}');
  await inDir(project, () => run('add', '--yes', '--no-plugins', '--stack', 'nextjs-ts-tailwind', '--platform', 'github-docker', '--patterns', 'modular-monolith'));
  assert.equal(fs.existsSync(path.join(project, '.npmrc')), false, 'keine Scope-Zeile auf eine Registry, die noch nicht antwortet');
  const doctor = await inDir(project, () => run('doctor', '--ci'));
  assert.match(doctor.out, /OK {4}npm-Paketzugang folgt mit dem Update bis 30\.11\.2026/);

  const update = await run('update', '--no-plugins');
  assert.equal(update.result, 0);
  assert.equal(update.out.split('\n').filter((l) => /npm/i.test(l)).join('\n'), 'npm-Paketzugang folgt mit dem Update bis 30.11.2026');
  assert.equal(rc(), 'save-exact=true\n');

  const logout = await run('logout', '--no-plugins');
  assert.doesNotMatch(logout.out, /npm/);
  assert.equal(rc(), 'save-exact=true\n');
});

test('Registry später eingerichtet: update richtet den Block ein, add schreibt dann die Scope-Zeile', async () => {
  state.dormant = true;
  await run('login', KEY, '--no-plugins');
  state.dormant = false;
  assert.match((await run('update', '--no-plugins')).out, /npm-Zugang eingerichtet/);
  assert.match(rc(), new RegExp(token('a')));
  const project = tmp();
  write(project, 'package.json', '{}');
  await inDir(project, () => run('add', '--yes', '--no-plugins', '--stack', 'nextjs-ts-tailwind', '--platform', 'github-docker', '--patterns', 'modular-monolith'));
  assert.equal(fs.readFileSync(path.join(project, '.npmrc'), 'utf8'), `@getitdone-gmbh:registry=${registry}\n`);
});

test('Figma noch nicht eingerichtet: kette figma nennt das Update und lädt nichts', async () => {
  await run('login', KEY, '--no-plugins');
  state.dormant = true;
  const out = path.join(tmp(), 'figma');
  const r = await run('figma', '--out', out);
  assert.equal(r.result, 0);
  assert.equal(r.out, 'Figma-Dateien folgen mit dem Update bis 30.11.2026');
  assert.equal(fs.existsSync(out), false);
  await assert.rejects(run('token', 'ci', 'list'), /npm-Paketzugang folgt mit dem Update bis 30\.11\.2026/);
});
