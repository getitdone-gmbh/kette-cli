import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { capture, fakeBundle, fakeClaude, json, serve, tmp, write } from './helpers.mjs';
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

// A Community project as the current folder while fn runs
async function inProject(fn) {
  const project = tmp();
  write(project, '.kette/profile.json', JSON.stringify({ version: 1, project: { name: 'x' }, stack: ['nestjs-prisma'], platform: { id: 'github-docker' }, patterns: ['layered'], tier: 'community' }));
  const cwd = process.cwd();
  process.chdir(project);
  try { return await fn(project); } finally { process.chdir(cwd); }
}
const enabled = (project) => JSON.parse(fs.readFileSync(path.join(project, '.claude', 'settings.json'), 'utf8')).enabledPlugins;

test('Community update in a project enables ui-laws there and leaves the user scope alone', { skip: process.platform === 'win32' }, async () => {
  await run('update', '--no-plugins');
  current = NEW;
  const claude = fakeClaude([], 'kette-engineering-core@kette\nui-gesetze@kette\n');
  await inProject(async (project) => {
    let out;
    try { ({ out } = await run('update')); } finally { claude.restore(); }
    const calls = claude.calls();
    assert.ok(calls.includes('plugin install ui-laws@kette --scope project'));
    assert.ok(!calls.some((c) => c.startsWith('plugin uninstall')));
    assert.equal(enabled(project)['ui-laws@kette'], true);
    assert.equal(enabled(project)['design-system-agents@kette'], false);
    assert.doesNotMatch(out, /not enabled/);
  });
});

test('Community update outside a project leaves Claude Code alone', { skip: process.platform === 'win32' }, async () => {
  current = NEW;
  const claude = fakeClaude([], 'kette-engineering-core@kette\n');
  let out;
  try { ({ out } = await run('update')); } finally { claude.restore(); }
  assert.ok(!claude.calls().some((c) => /^plugin (install|uninstall|marketplace)/.test(c)));
  assert.match(out, /Claude Code plugins are enabled per project/);
});

test('an up to date Community update in a project with matching settings changes no file', { skip: process.platform === 'win32' }, async () => {
  current = NEW;
  await inProject(async (project) => {
    await run('update', '--no-plugins');
    const claude = fakeClaude([]);
    try {
      await run('update');
      const first = fs.readFileSync(path.join(project, '.claude', 'settings.json'), 'utf8');
      const { out } = await run('update');
      assert.equal(fs.readFileSync(path.join(project, '.claude', 'settings.json'), 'utf8'), first);
      assert.doesNotMatch(out, /settings\.json (created|updated)/);
    } finally { claude.restore(); }
  });
});

test('a bundle without ui-laws names it as missing instead of failing', { skip: process.platform === 'win32' }, async () => {
  current = BARE;
  const claude = fakeClaude([]);
  await inProject(async () => {
    let out;
    try { ({ out } = await run('update')); } finally { claude.restore(); }
    assert.match(out, /WARN ui-laws not enabled, the bundles on this machine do not contain them\. Reload with: kette update/);
    assert.ok(claude.calls().includes('plugin install kette-engineering-core@kette --scope project'));
  });
});

test('an old bundle that still has ui-gesetze enables it for the project until ui-laws arrives', { skip: process.platform === 'win32' }, async () => {
  const claude = fakeClaude([]);
  await inProject(async () => {
    try { await run('update'); } finally { claude.restore(); }
    assert.ok(claude.calls().includes('plugin install ui-gesetze@kette --scope project'));
    assert.ok(!claude.calls().includes('plugin install ui-laws@kette --scope project'));
  });
});
