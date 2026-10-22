import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { capture, fakeBundle, fakeClaude, json, serve, tmp } from './helpers.mjs';
import { main } from '../src/cli.mjs';

// Community bundles before and after the agent pack renamed ui-gesetze to ui-laws
const OLD = '0.20261020.9';
const NEW = '0.20261022.40';
const BARE = '0.20261022.41';
const bundles = {
  [OLD]: fakeBundle(OLD, ['kette-engineering-core', 'ui-gesetze']),
  [NEW]: fakeBundle(NEW, ['kette-engineering-core', 'ui-laws']),
  [BARE]: fakeBundle(BARE, ['kette-engineering-core']),
};
let current = OLD;
let server;

before(async () => {
  server = await serve((req, res) => {
    if (req.url === '/manifest.json') return json(res, 200, { version: current, bundles: { community: { url: `kette-community-${current}.tgz`, sha256: bundles[current].sha256 } } });
    const m = req.url.match(/^\/kette-community-(.+)\.tgz$/);
    if (m && bundles[m[1]]) { res.writeHead(200); return res.end(bundles[m[1]].buf); }
    return json(res, 404, {});
  });
  process.env.KETTE_MIRROR = server.url;
});
after(() => { delete process.env.KETTE_MIRROR; return server.close(); });

let kh;
beforeEach(() => {
  kh = tmp();
  process.env.KETTE_HOME = kh;
  current = OLD;
});

const run = (...argv) => capture(() => main(argv));

test('Community update replaces the renamed ui-gesetze@kette with ui-laws@kette before the marketplace moves on', { skip: process.platform === 'win32' }, async () => {
  await run('update', '--no-plugins');
  current = NEW;
  const claude = fakeClaude([{ name: 'kette', source: 'directory', path: path.join(kh, 'bundles', 'active') }], 'kette-engineering-core@kette\nui-gesetze@kette\n');
  let out;
  try { ({ out } = await run('update')); } finally { claude.restore(); }
  const calls = claude.calls();
  const rm = calls.indexOf('plugin uninstall ui-gesetze@kette');
  assert.ok(rm >= 0 && rm < calls.indexOf('plugin marketplace update kette'), calls.join('\n'));
  assert.ok(calls.includes('plugin install ui-laws@kette'));
  assert.deepEqual(claude.installed(), ['kette-engineering-core@kette', 'ui-laws@kette']);
  assert.doesNotMatch(out, /does not contain/);
});

test('Community update leaves plugins alone when ui-gesetze is not installed', { skip: process.platform === 'win32' }, async () => {
  current = NEW;
  const claude = fakeClaude([], 'kette-engineering-core@kette\n');
  try { await run('update'); } finally { claude.restore(); }
  assert.ok(!claude.calls().some((c) => c.startsWith('plugin uninstall')));
  assert.deepEqual(claude.installed(), ['kette-engineering-core@kette', 'ui-laws@kette']);
});

test('Community update repairs the plugins when CLI 0.6.1 already loaded the bundle with ui-laws', { skip: process.platform === 'win32' }, async () => {
  current = NEW;
  await run('update', '--no-plugins');
  const claude = fakeClaude([{ name: 'kette', source: 'directory', path: path.join(kh, 'bundles', 'active') }], 'kette-engineering-core@kette\nui-gesetze@kette\n');
  let out;
  try { ({ out } = await run('update')); } finally { claude.restore(); }
  assert.match(out, /^Up to date \(version 0\.20261022\.40\)\.\nClaude Code plugins do not match the installed bundle, installing them again\.$/m);
  assert.deepEqual(claude.installed(), ['kette-engineering-core@kette', 'ui-laws@kette']);
});

test('Community update that is up to date with matching plugins leaves Claude Code alone', { skip: process.platform === 'win32' }, async () => {
  current = NEW;
  await run('update', '--no-plugins');
  const claude = fakeClaude([], 'kette-engineering-core@kette\nui-laws@kette\n');
  let out;
  try { ({ out } = await run('update')); } finally { claude.restore(); }
  assert.equal(out, 'Up to date (version 0.20261022.40).');
  assert.deepEqual(claude.calls().filter((c) => c !== '--version' && c !== 'plugin list'), []);
});

test('an up to date bundle without ui-laws does not trigger a repair on every update', { skip: process.platform === 'win32' }, async () => {
  current = BARE;
  await run('update', '--no-plugins');
  const claude = fakeClaude([], 'kette-engineering-core@kette\n');
  let out;
  try { ({ out } = await run('update')); } finally { claude.restore(); }
  assert.equal(out, `Up to date (version ${BARE}).`);
  assert.ok(!claude.calls().some((c) => /^plugin (install|uninstall|marketplace)/.test(c)));
});

test('an old bundle that still has ui-gesetze keeps it installed and is not repaired', { skip: process.platform === 'win32' }, async () => {
  await run('update', '--no-plugins');
  const claude = fakeClaude([], 'kette-engineering-core@kette\nui-gesetze@kette\n');
  let out;
  try { ({ out } = await run('update')); } finally { claude.restore(); }
  assert.equal(out, `Up to date (version ${OLD}).`);
  assert.deepEqual(claude.installed(), ['kette-engineering-core@kette', 'ui-gesetze@kette']);
});
