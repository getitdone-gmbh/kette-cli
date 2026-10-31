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
// Licence email as the delivery service sends it since CLI 0.6.4; undefined plays an older delivery service
const EMAIL = 'kunde+team@example.com';
let licenceEmail = EMAIL;

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
      return json(res, 200, { edition: 'enterprise', version: current, url: `${server.url}/install/download/${current}`, sha256: sum, expires_at: UNTIL, updates_until: UNTIL, seats: { used: 1, max: 3 }, email: licenceEmail });
    }
    if (url.pathname === '/install/latest') {
      if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
      return json(res, 200, { version: current, available: current, updates_until: UNTIL, email: licenceEmail });
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
  licenceEmail = EMAIL;
  requests.length = 0;
});

const run = (...argv) => capture(() => main(argv));
const ENTERPRISE_IDS = ['kette-engineering', 'design-system-agents', 'design-review-pack'].map((p) => `${p}@kette`);
const creds = () => path.join(kh, 'credentials');

test('login 200: Schlüssel mit Rechten 600, Paket geprüft und entpackt, Edition Enterprise', async () => {
  const { result, out } = await run('login', KEYS.ok, '--no-plugins');
  assert.equal(result, 0);
  assert.match(out, /Signed in: Enterprise \(Die Kette\), version 0\.20261020\.9, updates until 2027-10-20, devices 1 of 3/);
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
  ['401 unbekannter Schlüssel', KEYS.unknown, /do not know this license key.*purchase confirmation/],
  ['403 widerrufen', KEYS.revoked, /revoked or refunded.*info@itdone\.de.*Community edition keeps working/],
  ['403 falsches Angebot', KEYS.other, /different offer.*Solo or Team/],
  ['429 Gerätegrenze', KEYS.full, /device limit.*3 of 3 devices.*Support/],
];
for (const [name, key, message] of failing) {
  test(`login ${name}: verständlicher Fehler, nichts gespeichert`, async () => {
    await assert.rejects(run('login', key, '--no-plugins'), message);
    assert.equal(fs.existsSync(creds()), false);
    assert.equal(tierOf(), 'community');
  });
}

test('login mit falscher Prüfsumme installiert nichts', async () => {
  await assert.rejects(run('login', KEYS.badsum, '--no-plugins'), /checksum of the Enterprise bundle does not match, nothing was installed/);
  assert.equal(fs.existsSync(path.join(kh, 'bundles', 'enterprise', V1)), false);
  assert.equal(tierOf(), 'community');
  const { out } = await run('doctor', '--ci');
  assert.match(out, /FAIL License stored, but the Enterprise bundle is missing\. Load it with: kette update/);
});

test('login without an argument takes the key from KETTE_LICENSE_KEY', async () => {
  process.env.KETTE_LICENSE_KEY = KEYS.ok.toLowerCase();
  try {
    const { result } = await run('login', '--no-plugins');
    assert.equal(result, 0);
  } finally { delete process.env.KETTE_LICENSE_KEY; }
  assert.equal(requests[0].key, KEYS.ok);
  assert.deepEqual(JSON.parse(fs.readFileSync(creds(), 'utf8')), { key: KEYS.ok });
});

test('login lehnt ein falsches Format ab, ohne den Lieferdienst zu fragen', async () => {
  await assert.rejects(run('login', 'CDP-123'), /format CDP-XXXXX/);
  assert.equal(requests.length, 0);
});

test('doctor zeigt Edition, Version und Updates bis ohne Netz', async () => {
  await run('login', KEYS.ok, '--no-plugins');
  const offline = process.env.KETTE_DELIVERY;
  process.env.KETTE_DELIVERY = 'http://127.0.0.1:1';
  try {
    const { out } = await run('doctor', '--ci');
    assert.match(out, /OK {3}Edition Enterprise \(Die Kette\), version 0\.20261020\.9, updates until 2027-10-20/);
    assert.match(out, /OK {3}Rulebook installed \(Enterprise \(Die Kette\), version 0\.20261020\.9\)/);
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
    assert.match(out, /OK {3}Profile valid/);
    assert.match(out, /old value tier "kette", read as "enterprise"/);
    assert.equal(result, 0);
  } finally {
    process.chdir(cwd);
  }
});

test('update lädt eine neue Enterprise-Version über latest und token', async () => {
  await run('login', KEYS.ok, '--no-plugins');
  const same = await run('update', '--no-plugins');
  assert.match(same.out, /Up to date \(Enterprise \(Die Kette\) 0\.20261020\.9\)/);
  current = V2;
  const { result, out } = await run('update', '--no-plugins');
  assert.equal(result, 0);
  assert.match(out, /New Enterprise \(Die Kette\) version 0\.20261101\.12 \(installed: 0\.20261020\.9\)/);
  assert.ok(fs.existsSync(path.join(kh, 'bundles', 'enterprise', V2, 'VERSION')));
});

test('logout entfernt Schlüssel und Paket, die Geräte-ID bleibt', async () => {
  await run('login', KEYS.ok, '--no-plugins');
  const { out } = await run('logout', '--no-plugins');
  assert.match(out, /Signed out/);
  assert.equal(fs.existsSync(creds()), false);
  assert.equal(fs.existsSync(path.join(kh, 'bundles', 'enterprise')), false);
  assert.ok(fs.existsSync(path.join(kh, 'device-id')));
  assert.equal(tierOf(), 'community');
  assert.match((await run('logout')).out, /Not signed in/);
});

const loginEmail = () => JSON.parse(fs.readFileSync(path.join(kh, 'state.json'), 'utf8')).login?.email;

test('login keeps the licence email in the private state, never prints it, kette state only says it is stored, logout removes it', async () => {
  const { out } = await run('login', KEYS.ok, '--no-plugins');
  assert.equal(loginEmail(), EMAIL);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(kh, 'state.json')).mode & 0o777, 0o600);
  assert.ok(!out.includes(EMAIL));
  assert.ok(!(await run('doctor', '--ci')).out.includes(EMAIL));
  const state = await run('state');
  assert.ok(!state.out.includes(EMAIL));
  assert.equal(JSON.parse(state.out).login.email, '(stored)');
  await run('logout', '--no-plugins');
  assert.equal(loginEmail(), undefined);
});

test('update picks up the licence email when the login came from an older delivery service, a missing field keeps it', async () => {
  licenceEmail = undefined;
  await run('login', KEYS.ok, '--no-plugins');
  assert.equal(loginEmail(), null);
  licenceEmail = EMAIL;
  assert.ok(!(await run('update', '--no-plugins')).out.includes(EMAIL));
  assert.equal(loginEmail(), EMAIL);
  licenceEmail = undefined;
  await run('update', '--no-plugins');
  assert.equal(loginEmail(), EMAIL);
  licenceEmail = 'not an email';
  await run('update', '--no-plugins');
  assert.equal(loginEmail(), EMAIL, 'an invalid value is never stored');
});

test('cloud setup with an active licence opens the signup with the licence email prefilled, Community without', async () => {
  const ci = process.env.CI;
  process.env.CI = '1';
  process.env.KETTE_CLOUD_AUTH_URL = `${server.url}/realms/itdone`;
  const claude = fakeClaude();
  try {
    await run('login', KEYS.ok, '--no-plugins');
    const { result, out } = await run('cloud', 'setup');
    assert.equal(result, 0);
    const prefill = 'https://dashboard.itdone.cloud/login?register=1&login_hint=kunde%2Bteam@example.com';
    assert.ok(out.includes(`INFO Create your itdone.cloud account (email from your licence prefilled): ${prefill}`), out);
    assert.equal(out.split(EMAIL.replace('+', '%2B')).length - 1, 1, 'the email shows up only in the setup line');
    fs.rmSync(creds());
    const community = await run('cloud', 'setup', '--dry-run');
    assert.ok(community.out.includes('INFO Would open https://dashboard.itdone.cloud/login?register=1 in the browser'), community.out);
    assert.doesNotMatch(community.out, /login_hint|prefilled/);
  } finally {
    claude.restore();
    delete process.env.KETTE_CLOUD_AUTH_URL;
    if (ci === undefined) delete process.env.CI; else process.env.CI = ci;
  }
});

test('logout entfernt die Enterprise-Plugins', { skip: process.platform === 'win32' }, async () => {
  await run('login', KEYS.ok, '--no-plugins');
  const claude = fakeClaude([]);
  try { await run('logout'); } finally { claude.restore(); }
  const calls = claude.calls();
  for (const p of ['kette-engineering', 'design-system-agents', 'design-review-pack']) assert.ok(calls.includes(`plugin uninstall ${p}@kette`), p);
  assert.ok(!calls.includes('plugin uninstall kette-engineering-core@kette'));
});

test('logout entfernt Enterprise-Plugins vor dem Umschalten, prüft per Liste und meldet, was bleibt', { skip: process.platform === 'win32' }, async () => {
  await run('login', KEYS.ok, '--no-plugins');
  const claude = fakeClaude([], ['kette-engineering-core@kette', ...ENTERPRISE_IDS].join('\n'), { 'plugin uninstall design-system-agents@kette': { code: 1, out: 'Plugin not found' } });
  let out;
  try { ({ out } = await run('logout')); } finally { claude.restore(); }
  assert.match(out, /Plugin design-system-agents not removed \(Plugin not found\)\. By hand: claude plugin uninstall design-system-agents@kette/);
  assert.doesNotMatch(out, /Plugin kette-engineering not removed/);
  assert.deepEqual(claude.installed(), ['kette-engineering-core@kette', 'design-system-agents@kette']);
});

test('logout meldet den Fehler, wenn weder die Plugin-Liste noch das Entfernen gelingt', { skip: process.platform === 'win32' }, async () => {
  await run('login', KEYS.ok, '--no-plugins');
  const claude = fakeClaude([], ['kette-engineering-core@kette', ...ENTERPRISE_IDS].join('\n'), {
    'plugin list': { code: 1, out: 'list kaputt' },
    'plugin uninstall kette-engineering@kette': { code: 1, out: 'gesperrt' },
  });
  let out;
  try { ({ out } = await run('logout')); } finally { claude.restore(); }
  assert.match(out, /Plugin kette-engineering not removed \(gesperrt\)\. By hand: claude plugin uninstall kette-engineering@kette/);
  assert.doesNotMatch(out, /Plugin design-system-agents not removed/);
  assert.ok(claude.installed().includes('kette-engineering@kette'));
});

test('ohne lesbare Plugin-Liste gilt "not found in installed plugins" als schon entfernt', { skip: process.platform === 'win32' }, async () => {
  await run('login', KEYS.ok, '--no-plugins');
  const missing = (id) => ({ code: 1, out: `✘ Failed to uninstall plugin "${id}": Plugin "${id}" not found in installed plugins` });
  const claude = fakeClaude([], 'kette-engineering-core@kette\nkette-engineering@kette\n', {
    'plugin list': { code: 1, out: 'list kaputt' },
    'plugin uninstall design-system-agents@kette': missing('design-system-agents@kette'),
    'plugin uninstall design-review-pack@kette': missing('design-review-pack@kette'),
  });
  let out;
  try { ({ out } = await run('logout')); } finally { claude.restore(); }
  assert.doesNotMatch(out, /not removed/);
  assert.ok(!claude.installed().includes('kette-engineering@kette'));
});

test('update im Projekt erneuert den Kette-Block für die angemeldete Edition', async () => {
  await run('login', KEYS.ok, '--no-plugins');
  const project = tmp();
  write(project, '.kette/profile.json', JSON.stringify({ version: 1, project: { name: 'x' }, stack: ['nestjs-prisma'], platform: { id: 'github-docker' }, patterns: ['layered'], tier: 'enterprise' }));
  write(project, '.kette/README.md', '<!-- kette:begin alt -->\nCommunity-Ablauf\n<!-- kette:end -->\nNotiz\n');
  const cwd = process.cwd();
  process.chdir(project);
  try {
    const { out } = await run('update', '--no-plugins');
    assert.match(out, /\.kette\/README\.md updated \(flow for Enterprise \(Die Kette\)\)/);
    const note = fs.readFileSync(path.join(project, '.kette', 'README.md'), 'utf8');
    assert.match(note, /kette-engineering:code-reviewer/);
    assert.match(note, /<!-- kette:end -->\nNotiz\n$/);
    assert.doesNotMatch((await run('update', '--no-plugins')).out, /updated/);
  } finally {
    process.chdir(cwd);
  }
});

// A project with a profile of that edition as the current folder while fn runs; CLAUDE_CONFIG_DIR points to a sandbox so user scope is visible
async function inProject(tier, fn) {
  const project = tmp();
  write(project, '.kette/profile.json', JSON.stringify({ version: 1, project: { name: 'x' }, stack: ['nestjs-prisma'], platform: { id: 'github-docker' }, patterns: ['layered'], tier }));
  const cwd = process.cwd();
  const config = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = tmp();
  process.chdir(project);
  try { return await fn(fs.realpathSync(project), process.env.CLAUDE_CONFIG_DIR); } finally {
    process.chdir(cwd);
    if (config === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = config;
  }
}
const market = () => path.join(kh, 'bundles', 'marketplace');
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

test('login in a project enables the Enterprise plugins for that project only, never in the user scope', { skip: process.platform === 'win32' }, async () => {
  const claude = fakeClaude([]);
  await inProject('enterprise', async (project, config) => {
    try { await run('login', KEYS.ok, '--no-npm'); } finally { claude.restore(); }
    const calls = claude.calls();
    assert.ok(calls.includes(`plugin marketplace add --scope local ${market()}`));
    for (const p of ['kette-engineering-core', 'kette-engineering', 'design-system-agents', 'design-review-pack']) assert.ok(calls.includes(`plugin install ${p}@kette --scope project`), p);
    const cwds = claude.cwds();
    assert.ok(calls.every((c, i) => !c.includes('--scope') || fs.realpathSync(cwds[i]) === project), 'project and local scope run in the project folder');
    assert.equal(fs.existsSync(path.join(config, 'settings.json')), false, 'no plugin in the user settings');
    const enabled = readJson(path.join(project, '.claude', 'settings.json')).enabledPlugins;
    assert.equal(enabled['design-system-agents@kette'], true);
    assert.equal(enabled['ui-laws@kette'], false);
    assert.match(fs.readFileSync(path.join(project, '.gitignore'), 'utf8'), /^\.claude\/settings\.local\.json$/m);
    assert.equal(readJson(path.join(market(), '.claude-plugin', 'marketplace.json')).name, 'kette');
    assert.ok(!calls.some((c) => c.startsWith('plugin uninstall')));
  });
});

test('login outside a project enables no plugin and says plugins are enabled per project', { skip: process.platform === 'win32' }, async () => {
  const claude = fakeClaude([], 'kette-engineering-core@kette\nui-laws@kette\n');
  let out;
  try { ({ out } = await run('login', KEYS.ok, '--no-npm')); } finally { claude.restore(); }
  assert.match(out, /Claude Code plugins are enabled per project: run kette add in each project\./);
  assert.ok(!claude.calls().some((c) => /plugin (install|uninstall)|marketplace add/.test(c)), 'plugins of older versions in the user scope stay as they are');
});

test('login: a failing install names the commands for the project folder', { skip: process.platform === 'win32' }, async () => {
  const claude = fakeClaude([], '', { 'plugin install design-system-agents@kette --scope project': { code: 1, out: 'boom' } });
  await inProject('enterprise', async () => {
    let out;
    try { ({ out } = await run('login', KEYS.ok, '--no-npm')); } finally { claude.restore(); }
    assert.match(out, /Plugins not enabled for this project \(design-system-agents@kette: boom\)\. By hand in the project folder:\n  claude plugin marketplace add --scope local "[^"]+marketplace"\n  claude plugin install kette-engineering-core@kette --scope project\n/);
    assert.ok(!claude.installed().includes('design-review-pack@kette'));
  });
});

test('logout drops the Enterprise plugins from the marketplace and installs nothing', { skip: process.platform === 'win32' }, async () => {
  const community = path.join(kh, 'bundles', 'community', '0.20261022.46');
  write(community, '.claude-plugin/marketplace.json', '{"name":"kette","plugins":[]}');
  for (const p of ['kette-engineering-core', 'ui-laws']) write(community, `plugins/${p}/.claude-plugin/plugin.json`, '{}');
  fs.writeFileSync(path.join(kh, 'state.json'), JSON.stringify({ bundle_community: { version: '0.20261022.46', dir: community } }));
  const claude = fakeClaude([]);
  await inProject('enterprise', async () => {
    let out;
    try {
      await run('login', KEYS.ok, '--no-npm');
      assert.ok(fs.existsSync(path.join(market(), 'plugins', 'design-system-agents')));
      const before = claude.calls().length;
      ({ out } = await run('logout'));
      assert.ok(!claude.calls().slice(before).some((c) => c.startsWith('plugin install')));
    } finally { claude.restore(); }
    assert.deepEqual(fs.readdirSync(path.join(market(), 'plugins')).sort(), ['kette-engineering-core', 'ui-laws']);
    assert.match(out, /Enterprise projects keep their settings, their Enterprise plugins no longer load here\./);
    assert.equal(fs.realpathSync(path.join(kh, 'bundles', 'active')), fs.realpathSync(community));
  });
});

test('ein einzeln installiertes Agenten-Pack wird nicht angefasst, doppelte Plugins werden genannt', { skip: process.platform === 'win32' }, async () => {
  const claude = fakeClaude([{ name: 'claude-design-agent-pack', source: 'directory', path: '/zip/agent-pack' }], 'design-system-agents@claude-design-agent-pack\nui-gesetze@claude-design-agent-pack\n');
  await inProject('enterprise', async () => {
    let out;
    try { ({ out } = await run('login', KEYS.ok, '--no-npm')); } finally { claude.restore(); }
    assert.match(out, /WARN Marketplace claude-design-agent-pack \(\/zip\/agent-pack\) stays untouched\. .*Disable with: claude plugin disable design-system-agents@claude-design-agent-pack$/m);
    assert.ok(!claude.calls().some((c) => /claude-design-agent-pack/.test(c) && /uninstall|remove/.test(c)));
  });
});

test('Enterprise update that is up to date enables the plugins of the project in this folder', { skip: process.platform === 'win32' }, async () => {
  await run('login', KEYS.ok, '--no-plugins', '--no-npm');
  const claude = fakeClaude([], 'ui-gesetze@kette\n');
  await inProject('enterprise', async (project) => {
    let out;
    try { ({ out } = await run('update', '--no-npm')); } finally { claude.restore(); }
    assert.match(out, /Up to date \(Enterprise \(Die Kette\) 0\.20261020\.9\)\./);
    assert.match(out, /Claude Code plugins enabled for this project: kette-engineering-core@kette, kette-engineering@kette, design-system-agents@kette, design-review-pack@kette/);
    assert.ok(!claude.calls().includes('plugin uninstall ui-gesetze@kette'), 'the user scope stays as it is');
    assert.equal(readJson(path.join(project, '.claude', 'settings.json')).enabledPlugins['design-review-pack@kette'], true);
  });
});

test('a marketplace kette on an old bundle under ~/.kette is declared again for the project, nothing removed', { skip: process.platform === 'win32' }, async () => {
  const claude = fakeClaude([{ name: 'kette', source: 'directory', path: path.join(kh, 'bundles', 'community', '0.20261020.7') }]);
  await inProject('enterprise', async () => {
    try { await run('login', KEYS.ok, '--no-npm'); } finally { claude.restore(); }
    const calls = claude.calls();
    assert.ok(!calls.includes('plugin marketplace remove kette'));
    assert.ok(calls.includes(`plugin marketplace add --scope local ${market()}`));
  });
});

test('ein fremder Marketplace kette bleibt unangetastet', { skip: process.platform === 'win32' }, async () => {
  const claude = fakeClaude([{ name: 'kette', source: 'directory', path: '/repos/kette' }]);
  await inProject('enterprise', async () => {
    let out;
    try { ({ out } = await run('login', KEYS.ok, '--no-npm')); } finally { claude.restore(); }
    assert.match(out, /Plugins not enabled for this project \(Marketplace kette points to \/repos\/kette\./);
    assert.ok(!claude.calls().some((c) => /marketplace (remove|add)|plugin install/.test(c)));
  });
});

test('Migration: der alte, selbst angelegte Marketplace kette-engineering wird durch kette ersetzt', { skip: process.platform === 'win32' }, async () => {
  const claude = fakeClaude([{ name: 'kette-engineering', source: 'directory', path: path.join(kh, 'bundles', 'active') }]);
  await inProject('enterprise', async () => {
    let out;
    try { ({ out } = await run('login', KEYS.ok, '--no-npm')); } finally { claude.restore(); }
    const calls = claude.calls();
    const rm = calls.indexOf('plugin marketplace remove kette-engineering');
    assert.ok(calls.indexOf('plugin uninstall kette-engineering-core@kette-engineering') < rm);
    assert.ok(calls.indexOf('plugin uninstall kette-engineering@kette-engineering') < rm);
    assert.ok(rm >= 0 && calls.indexOf(`plugin marketplace add --scope local ${market()}`) > rm);
    assert.ok(calls.includes('plugin install kette-engineering@kette --scope project'));
    assert.doesNotMatch(out, /twice/);
  });
});

test('Migration: kette-engineering auf ein Entwickler-Repo bleibt, kette kommt dazu, Hinweis auf doppelte Skills', { skip: process.platform === 'win32' }, async () => {
  const plugins = 'Installed plugins:\n\n  ❯ kette-engineering-core@kette-engineering\n    Status: enabled\n';
  const claude = fakeClaude([{ name: 'kette-engineering', source: 'directory', path: '/repos/kette-engineering' }], plugins);
  await inProject('enterprise', async () => {
    let out;
    try { ({ out } = await run('login', KEYS.ok, '--no-npm')); } finally { claude.restore(); }
    const calls = claude.calls();
    assert.ok(!calls.some((c) => /marketplace remove|uninstall/.test(c)));
    assert.ok(calls.includes(`plugin marketplace add --scope local ${market()}`));
    assert.ok(calls.includes('plugin install kette-engineering-core@kette --scope project'));
    assert.match(out, /WARN Marketplace kette-engineering \(\/repos\/kette-engineering\) stays untouched\. .*skills show up twice\. Disable with: claude plugin disable kette-engineering-core@kette-engineering$/m);
  });
});
