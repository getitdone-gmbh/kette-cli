import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { capture, fakeBundle, fakeClaude, json, serve, tmp, write } from './helpers.mjs';
import { main } from '../src/cli.mjs';
import { tierOf } from '../src/enterprise.mjs';

const KEYS = {
  ok: 'CDP-AAAAA-BBBBB-CCCCC-00001',
  unknown: 'CDP-AAAAA-BBBBB-CCCCC-00401',
  revoked: 'CDP-AAAAA-BBBBB-CCCCC-00403',
  other: 'CDP-AAAAA-BBBBB-CCCCC-00404',
  full: 'CDP-AAAAA-BBBBB-CCCCC-00429',
  badsum: 'CDP-AAAAA-BBBBB-CCCCC-00666',
};
const V1 = '0.20261020.9';
const V2 = '0.20261101.12';
const UNTIL = '2027-10-20T00:00:00.000Z';
const bundles = { [V1]: fakeBundle(V1), [V2]: fakeBundle(V2) };
const requests = [];
let server;
let current = V1;

before(async () => {
  server = await serve((req, res, body) => {
    const url = new URL(req.url, server.url);
    if (req.method === 'POST' && url.pathname === '/install/token') {
      const b = JSON.parse(body);
      requests.push(b);
      if (b.key === KEYS.unknown) return json(res, 401, { error: 'invalid_key' });
      if (b.key === KEYS.revoked) return json(res, 403, { error: 'revoked' });
      if (b.key === KEYS.other) return json(res, 403, { error: 'wrong_offer' });
      if (b.key === KEYS.full) return json(res, 429, { error: 'device_limit', seats: { used: 3, max: 3 } });
      const sum = b.key === KEYS.badsum ? '0'.repeat(64) : bundles[current].sha256;
      return json(res, 200, { edition: 'enterprise', version: current, url: `${server.url}/install/download/${current}`, sha256: sum, expires_at: UNTIL, updates_until: UNTIL, seats: { used: 1, max: 3 } });
    }
    if (url.pathname === '/install/latest') {
      if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
      return json(res, 200, { version: current, available: current, updates_until: UNTIL });
    }
    const m = url.pathname.match(/^\/install\/download\/(.+)$/);
    if (m && bundles[m[1]]) { res.writeHead(200, { 'content-type': 'application/gzip' }); return res.end(bundles[m[1]].buf); }
    if (m && m[1] === 'expired') return json(res, 410, {});
    return json(res, 404, {});
  });
  process.env.KETTE_DELIVERY = server.url;
});
after(() => server.close());

let kh;
beforeEach(() => {
  kh = tmp();
  process.env.KETTE_HOME = kh;
  current = V1;
  requests.length = 0;
});

const run = (...argv) => capture(() => main(argv));
const creds = () => path.join(kh, 'credentials');

test('login 200: Schlüssel mit Rechten 600, Paket geprüft und entpackt, Edition Enterprise', async () => {
  const { result, out } = await run('login', KEYS.ok, '--no-plugins');
  assert.equal(result, 0);
  assert.match(out, /Angemeldet: Enterprise \(Die Kette\), Version 0\.20261020\.9, Updates bis 20\.10\.2027, Geräte 1 von 3/);
  assert.deepEqual(JSON.parse(fs.readFileSync(creds(), 'utf8')), { key: KEYS.ok });
  if (process.platform !== 'win32') assert.equal(fs.statSync(creds()).mode & 0o777, 0o600);
  assert.ok(fs.existsSync(path.join(kh, 'bundles', 'enterprise', V1, '.claude-plugin', 'marketplace.json')));
  assert.equal(tierOf(), 'enterprise');
  const device = fs.readFileSync(path.join(kh, 'device-id'), 'utf8').trim();
  assert.match(device, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.deepEqual(requests[0], { key: KEYS.ok, device, cli: JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url))).version });
});

test('login zieht die Rechte einer vorhandenen Schlüsseldatei auf 600 und behält die Geräte-ID', { skip: process.platform === 'win32' }, async () => {
  write(kh, 'credentials', '{}');
  fs.chmodSync(creds(), 0o644);
  await run('login', KEYS.ok, '--no-plugins');
  const first = requests[0].device;
  await run('login', KEYS.ok.toLowerCase(), '--no-plugins');
  assert.equal(fs.statSync(creds()).mode & 0o777, 0o600);
  assert.equal(requests[1].device, first);
  assert.equal(requests[1].key, KEYS.ok);
});

const failing = [
  ['401 unbekannter Schlüssel', KEYS.unknown, /kennen wir nicht.*Kaufbestätigung/],
  ['403 widerrufen', KEYS.revoked, /widerrufen oder erstattet.*info@itdone\.de.*Community-Edition bleibt nutzbar/],
  ['403 falsches Angebot', KEYS.other, /anderen Angebot.*Solo oder Team/],
  ['429 Gerätegrenze', KEYS.full, /Gerätegrenze.*3 von 3 Geräten.*Support/],
];
for (const [name, key, message] of failing) {
  test(`login ${name}: verständlicher Fehler, nichts gespeichert`, async () => {
    await assert.rejects(run('login', key, '--no-plugins'), message);
    assert.equal(fs.existsSync(creds()), false);
    assert.equal(tierOf(), 'community');
  });
}

test('login mit falscher Prüfsumme installiert nichts', async () => {
  await assert.rejects(run('login', KEYS.badsum, '--no-plugins'), /Prüfsumme des Enterprise-Pakets stimmt nicht, es wurde nichts installiert/);
  assert.equal(fs.existsSync(path.join(kh, 'bundles', 'enterprise', V1)), false);
  assert.equal(tierOf(), 'community');
  const { out } = await run('doctor', '--ci');
  assert.match(out, /FEHLT Lizenz hinterlegt, aber das Enterprise-Paket fehlt\. Nachladen mit: kette update/);
});

test('login lehnt ein falsches Format ab, ohne den Lieferdienst zu fragen', async () => {
  await assert.rejects(run('login', 'CDP-123'), /Format CDP-XXXXX/);
  assert.equal(requests.length, 0);
});

test('doctor zeigt Edition, Version und Updates bis ohne Netz', async () => {
  await run('login', KEYS.ok, '--no-plugins');
  const offline = process.env.KETTE_DELIVERY;
  process.env.KETTE_DELIVERY = 'http://127.0.0.1:1';
  try {
    const { out } = await run('doctor', '--ci');
    assert.match(out, /OK {4}Edition Enterprise \(Die Kette\), Version 0\.20261020\.9, Updates bis 20\.10\.2027/);
    assert.match(out, /OK {4}Regelwerk installiert \(Enterprise \(Die Kette\), Version 0\.20261020\.9\)/);
  } finally {
    process.env.KETTE_DELIVERY = offline;
  }
});

test('doctor liest ein Profil aus 0.1.0 mit tier kette und weist auf den neuen Namen hin', async () => {
  await run('login', KEYS.ok, '--no-plugins');
  const project = tmp();
  write(project, '.kette/profile.json', JSON.stringify({ version: 1, project: { name: 'x' }, stack: ['nestjs-prisma'], platform: { id: 'github-docker' }, patterns: ['layered'], tier: 'kette' }));
  write(project, 'CLAUDE.md', '@.kette/README.md\n');
  const cwd = process.cwd();
  process.chdir(project);
  try {
    const { result, out } = await run('doctor', '--ci');
    assert.match(out, /OK {4}Profil gültig/);
    assert.match(out, /alten Wert tier "kette", gelesen als "enterprise"/);
    assert.equal(result, 0);
  } finally {
    process.chdir(cwd);
  }
});

test('update lädt eine neue Enterprise-Version über latest und token', async () => {
  await run('login', KEYS.ok, '--no-plugins');
  const same = await run('update', '--no-plugins');
  assert.match(same.out, /Aktuell \(Enterprise \(Die Kette\) 0\.20261020\.9\)/);
  current = V2;
  const { result, out } = await run('update', '--no-plugins');
  assert.equal(result, 0);
  assert.match(out, /Neue Enterprise \(Die Kette\)-Version 0\.20261101\.12 \(installiert: 0\.20261020\.9\)/);
  assert.ok(fs.existsSync(path.join(kh, 'bundles', 'enterprise', V2, 'VERSION')));
});

test('logout entfernt Schlüssel und Paket, die Geräte-ID bleibt', async () => {
  await run('login', KEYS.ok, '--no-plugins');
  const { out } = await run('logout', '--no-plugins');
  assert.match(out, /Abgemeldet/);
  assert.equal(fs.existsSync(creds()), false);
  assert.equal(fs.existsSync(path.join(kh, 'bundles', 'enterprise')), false);
  assert.ok(fs.existsSync(path.join(kh, 'device-id')));
  assert.equal(tierOf(), 'community');
  assert.match((await run('logout')).out, /Nicht angemeldet/);
});

test('login installiert beide Plugins über den festen Pfad des aktiven Pakets', { skip: process.platform === 'win32' }, async () => {
  const claude = fakeClaude([]);
  try { await run('login', KEYS.ok); } finally { claude.restore(); }
  const link = path.join(kh, 'bundles', 'active');
  assert.equal(fs.realpathSync(link), fs.realpathSync(path.join(kh, 'bundles', 'enterprise', V1)));
  const calls = claude.calls();
  assert.ok(calls.includes(`plugin marketplace add ${link}`));
  assert.ok(calls.includes('plugin install kette-engineering-core@kette-engineering'));
  assert.ok(calls.includes('plugin install kette-engineering@kette-engineering'));
});

test('ein Marketplace auf ein altes Paket unter ~/.kette wird umgestellt', { skip: process.platform === 'win32' }, async () => {
  const claude = fakeClaude([{ name: 'kette-engineering', source: 'directory', path: path.join(kh, 'bundles', 'free', '0.20261020.7') }]);
  try { await run('login', KEYS.ok); } finally { claude.restore(); }
  const calls = claude.calls();
  const rm = calls.indexOf('plugin marketplace remove kette-engineering');
  assert.ok(rm >= 0 && calls.indexOf(`plugin marketplace add ${path.join(kh, 'bundles', 'active')}`) > rm);
});

test('ein fremder Marketplace gleichen Namens bleibt unangetastet', { skip: process.platform === 'win32' }, async () => {
  const claude = fakeClaude([{ name: 'kette-engineering', source: 'directory', path: '/repos/kette-engineering' }]);
  let out;
  try { ({ out } = await run('login', KEYS.ok)); } finally { claude.restore(); }
  assert.match(out, /Plugins nicht installiert \(Marketplace kette-engineering zeigt auf \/repos\/kette-engineering/);
  assert.ok(!claude.calls().some((c) => /marketplace (remove|add)|plugin install/.test(c)));
});
