import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { write } from './helpers.mjs';
import { BIN, CLAUDE_REGISTRY, ENTERPRISE_ONLY, KEY, NPMRC, SETUP, instanceRepo, interactive, kette, ok, posixOnly, profile, readInstanceFile, sandbox, settings, start, stop } from './sandbox-harness.mjs';

// Regression tests for the findings of fix round 1 (code review CR-*, independent QA QA-*), taken from the QA scenarios
before(start);
after(() => stop('sandbox-qa'));

const NO_STACK = /    at |node:internal/;
const rec = (scenario) => ({ record: scenario });
const stateOf = (box) => JSON.parse(fs.readFileSync(path.join(box.home, '.kette', 'state.json'), 'utf8'));
const exists = (f) => fs.existsSync(f);
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

// Two instances on a licensed machine, one repo each
async function twoInstances(box, scenario, { npm = false } = {}) {
  const [ent, com] = [path.join(box.work, 'ent'), path.join(box.work, 'com')];
  ok(await kette(box, ['login', KEY, ...(npm ? [] : ['--no-npm'])], { ...rec(scenario), allow: npm ? NPMRC : [] }));
  ok(await kette(box, ['instance', 'create', 'acme', '--edition', 'enterprise'], rec(scenario)));
  ok(await kette(box, ['instance', 'create', 'oss', '--edition', 'community'], rec(scenario)));
  ok(await kette(box, ['init', ent, '--instance', 'acme', ...SETUP], { ...rec(scenario), projects: [ent], allow: CLAUDE_REGISTRY }));
  ok(await kette(box, ['init', com, '--instance', 'oss', ...SETUP], { ...rec(scenario), projects: [com], allow: CLAUDE_REGISTRY }));
  return { ent, com };
}

test('D2, QA-02, QA-03: a Community repo on a licensed machine loads and names only Community content', async () => {
  const box = sandbox();
  const { ent, com } = await twoInstances(box, 'D2');
  const rules = ok(await kette(box, ['rules', '--path'], { ...rec('D2'), cwd: com }));
  assert.doesNotMatch(rules.out, /enterprise/i);
  const overview = ok(await kette(box, ['rules'], { ...rec('D2'), cwd: com }));
  assert.match(overview.out, /edition Community/);
  assert.match(overview.out, /Location: ~\/\.kette\/bundles\/community\//);
  const note = fs.readFileSync(path.join(com, '.kette', 'README.md'), 'utf8');
  assert.match(note, /~\/\.kette\/bundles\/community\//);
  assert.doesNotMatch(note, /bundles\/enterprise|bundles\/active|@kette-enterprise|design-system-agents/);
  const marketplaces = path.join(box.home, '.kette', 'bundles');
  assert.equal(fs.readFileSync(path.join(marketplaces, 'marketplace-community', 'plugins', 'kette-engineering-core', 'EDITION'), 'utf8'), 'community', 'the shared plugin of the Community repo is the Community copy');
  assert.equal(fs.readFileSync(path.join(marketplaces, 'marketplace-enterprise', 'plugins', 'kette-engineering-core', 'EDITION'), 'utf8'), 'enterprise');
  const local = JSON.parse(fs.readFileSync(path.join(com, '.claude', 'settings.local.json'), 'utf8'));
  assert.deepEqual(Object.keys(local.extraKnownMarketplaces), ['kette-community']);
  assert.equal(settings(com)['kette-engineering-core@kette-community'], true);
  assert.equal(settings(com)['kette-engineering-core@kette-enterprise'], false);
  assert.equal(settings(ent)['kette-engineering-core@kette-enterprise'], true);
  const comInstalls = box.claude.calls().filter((c, i) => fs.realpathSync(box.claude.cwds()[i]) === com && c.startsWith('plugin install'));
  assert.ok(comInstalls.length && comInstalls.every((c) => /@kette-community --scope project$/.test(c)), comInstalls.join('\n'));
  ok(await kette(box, ['doctor'], { ...rec('D2'), cwd: com }));
  ok(await kette(box, ['doctor'], { ...rec('D2'), cwd: ent }));
});

test('CR-SCOPE-1, QA-04, QA-06, CR-DEST-1: an instance that cannot be used counts as Community; login and update finish, remove works', async () => {
  const box = sandbox();
  const app = path.join(box.work, 'app');
  ok(await kette(box, ['login', KEY], { ...rec('fail-closed'), allow: NPMRC }));
  ok(await kette(box, ['instance', 'create', 'acme', '--edition', 'enterprise'], rec('fail-closed')));
  ok(await kette(box, ['init', app, '--instance', 'acme', ...SETUP], { ...rec('fail-closed'), projects: [app], allow: CLAUDE_REGISTRY }));
  const f = path.join(box.home, '.kette', 'instances', 'acme', 'instance.json');
  const good = fs.readFileSync(f, 'utf8');
  const variants = { 'invalid JSON': '{ "version": 1, ', 'unknown field': JSON.stringify({ ...JSON.parse(good), edtion: 'x' }), 'bad edition': JSON.stringify({ ...JSON.parse(good), edition: 'gold' }), 'name mismatch': JSON.stringify({ ...JSON.parse(good), name: 'other' }), 'empty file': '' };
  for (const [what, content] of Object.entries(variants)) {
    fs.writeFileSync(f, content);
    const r = { ...rec('fail-closed'), cwd: app };
    const wallet = ok(await kette(box, ['wallet', 'init', '--yes'], r), 1);
    assert.match(wallet.out, /part of Enterprise/, what);
    assert.equal(exists(path.join(app, '.kette', 'wallet.json')), false, `${what}: an Enterprise feature never runs on a damaged Enterprise instance`);
    const login = ok(await kette(box, ['login', KEY], { ...r, allow: NPMRC }));
    assert.match(login.out, /WARN .*Plugins of this project left as they are/, what);
    assert.match(login.out, /Signed in/, what);
    assert.doesNotMatch(login.out, NO_STACK);
    const update = ok(await kette(box, ['update'], { ...r, allow: NPMRC }));
    assert.doesNotMatch(update.out, NO_STACK);
    for (const argv of [['doctor'], ['profile', '--effective'], ['add', ...SETUP]]) {
      const res = ok(await kette(box, argv, r), 1);
      assert.doesNotMatch(res.out, NO_STACK, `${what}: ${argv.join(' ')}`);
    }
    ok(await kette(box, ['instance', 'remove', 'acme', '--yes'], rec('fail-closed')));
    assert.equal(exists(path.dirname(f)), false, `${what}: a damaged instance can be removed`);
    write(path.dirname(f), 'instance.json', good);
  }
  fs.rmSync(path.dirname(f), { recursive: true });
  const missing = ok(await kette(box, ['wallet', 'init', '--yes'], { ...rec('fail-closed'), cwd: app }), 1);
  assert.match(missing.out, /part of Enterprise/);
  const eff = ok(await kette(box, ['profile', '--effective'], { ...rec('fail-closed'), cwd: app }), 1);
  assert.match(eff.out, /Instance acme not found/);
});

test('D7, QA-05, CR-SCOPE-3: joining a Community instance removes the Enterprise files kette wrote, changed ones make doctor fail', async () => {
  const box = sandbox();
  const app = path.join(box.work, 'app');
  ok(await kette(box, ['login', KEY], { ...rec('D7'), allow: NPMRC }));
  ok(await kette(box, ['instance', 'create', 'acme', '--edition', 'enterprise'], rec('D7')));
  ok(await kette(box, ['instance', 'create', 'oss', '--edition', 'community'], rec('D7')));
  ok(await kette(box, ['init', app, '--instance', 'acme', ...SETUP], { ...rec('D7'), projects: [app], allow: CLAUDE_REGISTRY }));
  for (const f of ['.npmrc', '.gitleaks.toml', 'Dockerfile', 'compose.yaml', '.github/workflows/ci.yml']) assert.ok(exists(path.join(app, f)), f);
  fs.writeFileSync(path.join(app, 'compose.yaml'), 'services: { mine: {} }\n');
  const use = ok(await kette(box, ['instance', 'use', 'oss'], { ...rec('D7'), cwd: app, allow: CLAUDE_REGISTRY }));
  assert.match(use.out, /compose\.yaml is an Enterprise template that was changed, it stays/);
  for (const f of ['.npmrc', '.gitleaks.toml', 'Dockerfile', '.github']) assert.equal(exists(path.join(app, f)), false, `${f} removed`);
  assert.ok(exists(path.join(app, 'compose.yaml')), 'a changed template stays');
  const doctor = ok(await kette(box, ['doctor'], { ...rec('D7'), cwd: app }), 1);
  assert.match(doctor.out, /FAIL Enterprise templates changed by hand in this Community project: compose\.yaml/);
  fs.rmSync(path.join(app, 'compose.yaml'));
  ok(await kette(box, ['doctor'], { ...rec('D7'), cwd: app }));
  // A Community project with the registry line kette did not record still fails doctor
  write(app, '.npmrc', '@getitdone-gmbh:registry=https://npm.kette.itdone.de/\n');
  const npm = ok(await kette(box, ['doctor'], { ...rec('D7'), cwd: app }), 1);
  assert.match(npm.out, /FAIL \.npmrc of this Community project points @getitdone-gmbh to the Enterprise registry\. Remove the line with: kette instance use oss/);
});

test('QA-07, CR-SCOPE-2, QA-08: a repo is in one instance only; repos without origin, same names and worktrees are all tracked', async () => {
  const box = sandbox();
  ok(await kette(box, ['update'], rec('identity')));
  ok(await kette(box, ['instance', 'create', 'acme', '--edition', 'community'], rec('identity')));
  ok(await kette(box, ['instance', 'create', 'beta', '--edition', 'community'], rec('identity')));
  const app = path.join(box.work, 'app');
  ok(await kette(box, ['init', app, '--instance', 'acme', ...SETUP, '--no-plugins'], { ...rec('identity'), projects: [app] }));
  ok(await kette(box, ['instance', 'add-repo', '--instance', 'beta'], { ...rec('identity'), cwd: app }));
  assert.deepEqual([readInstanceFile(box, 'acme').repos.length, readInstanceFile(box, 'beta').repos.length], [0, 1], 'add-repo moves the repo');
  ok(await kette(box, ['add', '--instance', 'acme', ...SETUP, '--no-plugins'], { ...rec('identity'), cwd: app }));
  assert.deepEqual([readInstanceFile(box, 'acme').repos.length, readInstanceFile(box, 'beta').repos.length], [1, 0], 'add --instance moves it back');
  const [a1, a2] = [path.join(box.work, 'x', 'web'), path.join(box.work, 'y', 'web')];
  for (const d of [a1, a2]) ok(await kette(box, ['init', d, '--instance', 'acme', ...SETUP, '--no-plugins'], { ...rec('identity'), projects: [path.dirname(d)] }));
  assert.deepEqual(readInstanceFile(box, 'acme').repos.map((r) => r.name).sort(), ['app', 'web', 'web-2']);
  // --ci: these repos were set up with --no-plugins, the checks here are about which checkouts doctor visits
  const doc = ok(await kette(box, ['doctor', '--instance', 'acme', '--ci'], rec('identity')));
  assert.ok(doc.out.includes(path.join('x', 'web')) && doc.out.includes(path.join('y', 'web')), doc.out);
  assert.match(doc.out, /Instance acme: 3 of 3 repos all good/);
  // A main checkout with origin and its worktree: one repo, both checkouts checked
  const main = path.join(box.work, 'main');
  const remote = path.join(box.root, 'remote', 'main.git');
  const g = (...args) => execFileSync('git', args, { env: box.env, stdio: 'pipe' });
  g('init', '-q', '--bare', remote);
  g('init', '-q', main);
  g('-C', main, 'remote', 'add', 'origin', remote);
  write(main, 'README', 'x');
  g('-C', main, 'add', '.');
  g('-C', main, 'commit', '-qm', 'x');
  const wt = path.join(box.work, 'main-wt');
  g('-C', main, 'worktree', 'add', '-q', wt);
  ok(await kette(box, ['add', '--instance', 'acme', ...SETUP, '--no-plugins'], { ...rec('identity'), cwd: main }));
  ok(await kette(box, ['add', '--instance', 'acme', ...SETUP, '--no-plugins'], { ...rec('identity'), cwd: wt }));
  assert.equal(readInstanceFile(box, 'acme').repos.filter((r) => r.name === 'main').length, 1, 'worktree and main checkout are one repo');
  const checkouts = Object.keys(stateOf(box).instances.acme.checkouts);
  assert.ok(checkouts.includes(fs.realpathSync(main)) && checkouts.includes(fs.realpathSync(wt)));
  const both = ok(await kette(box, ['doctor', '--instance', 'acme', '--ci'], rec('identity')));
  assert.match(both.out, /Instance acme: 5 of 5 repos all good/);
  ok(await kette(box, ['add', '--instance', 'beta', ...SETUP, '--no-plugins'], { ...rec('identity'), cwd: wt }));
  assert.equal(readInstanceFile(box, 'acme').repos.some((r) => r.name === 'main'), false, 'the repo left acme with all its checkouts');
  const beta = readInstanceFile(box, 'beta').repos;
  assert.equal(beta.length, 1, 'one repo, whichever checkout joined');
  assert.equal(fs.realpathSync(beta[0].url), fs.realpathSync(remote), 'identified by its origin');
});

// Runs kette processes at once and resolves with their exit codes and error lines
const parallel = (box, jobs) => Promise.all(jobs.map(({ cwd, argv }) => new Promise((resolve) => {
  const c = spawn(process.execPath, [BIN, ...argv], { cwd, env: box.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  c.stdout.on('data', (x) => { out += x; });
  c.stderr.on('data', (x) => { out += x; });
  c.on('close', (code) => resolve({ code, out }));
})));

test('QA-01: 6 repos x 5 rounds of parallel instance use stay consistent, a parallel first marketplace build leaves no temp folder', async () => {
  const box = sandbox();
  ok(await kette(box, ['update'], rec('concurrency')));
  ok(await kette(box, ['instance', 'create', 'acme', '--edition', 'community'], rec('concurrency')));
  ok(await kette(box, ['instance', 'create', 'beta', '--edition', 'community'], rec('concurrency')));
  const repos = [];
  for (let i = 0; i < 6; i++) { const d = path.join(box.work, `r${i}`); repos.push(d); ok(await kette(box, ['init', d, ...SETUP, '--no-plugins'], { ...rec('concurrency'), projects: [d] })); }
  for (let round = 0; round < 5; round++) {
    const [target, other] = round % 2 ? ['beta', 'acme'] : ['acme', 'beta'];
    const rs = await parallel(box, repos.map((cwd) => ({ cwd, argv: ['instance', 'use', target, '--no-plugins'] })));
    assert.deepEqual(rs.map((r) => r.code), [0, 0, 0, 0, 0, 0], rs.filter((r) => r.code).map((r) => r.out).join('\n'));
    assert.equal(readInstanceFile(box, target).repos.length, 6, `round ${round}: every repo in ${target}`);
    assert.equal(readInstanceFile(box, other).repos.length, 0, `round ${round}: no repo left in ${other}`);
    assert.equal(Object.keys(stateOf(box).instances[target].checkouts).length, 6);
  }
  const box2 = sandbox();
  ok(await kette(box2, ['login', KEY, '--no-npm'], rec('concurrency')));
  ok(await kette(box2, ['instance', 'create', 'acme', '--edition', 'enterprise'], rec('concurrency')));
  ok(await kette(box2, ['instance', 'create', 'oss', '--edition', 'community'], rec('concurrency')));
  const ds = [];
  for (let i = 0; i < 4; i++) { const d = path.join(box2.work, `p${i}`); ds.push(d); ok(await kette(box2, ['init', d, ...SETUP, '--no-plugins'], { ...rec('concurrency'), projects: [d] })); }
  for (const m of ['marketplace-community', 'marketplace-enterprise', 'community']) fs.rmSync(path.join(box2.home, '.kette', 'bundles', m), { recursive: true, force: true });
  const state = stateOf(box2);
  delete state.bundle_community;
  fs.writeFileSync(path.join(box2.home, '.kette', 'state.json'), JSON.stringify(state));
  const rs = await parallel(box2, ds.map((cwd, i) => ({ cwd, argv: ['instance', 'use', i % 2 ? 'oss' : 'acme'] })));
  assert.deepEqual(rs.map((r) => r.code), [0, 0, 0, 0], rs.filter((r) => r.code).map((r) => r.out).join('\n'));
  const leftovers = fs.readdirSync(path.join(box2.home, '.kette', 'bundles'), { recursive: true }).filter((n) => /\.tmp|\.tgz/.test(String(n)));
  assert.deepEqual(leftovers, []);
  for (const m of ['marketplace-community', 'marketplace-enterprise']) assert.ok(exists(path.join(box2.home, '.kette', 'bundles', m, '.claude-plugin', 'marketplace.json')), m);
  assert.equal(exists(path.join(box2.home, '.kette', 'locks')) ? fs.readdirSync(path.join(box2.home, '.kette', 'locks')).length : 0, 0, 'every lock released');
});

test('QA-09: a long folder name joins, a read-only instance.json stops init before the project is written', { skip: (posixOnly || isRoot) && 'needs POSIX file modes and no root' }, async () => {
  const box = sandbox();
  ok(await kette(box, ['update'], rec('QA-09')));
  ok(await kette(box, ['instance', 'create', 'uni', '--edition', 'community'], rec('QA-09')));
  const long = path.join(box.work, 'r'.repeat(120));
  ok(await kette(box, ['init', long, '--instance', 'uni', ...SETUP, '--no-plugins'], { ...rec('QA-09'), projects: [long] }));
  assert.equal(readInstanceFile(box, 'uni').repos.length, 1);
  const idir = path.join(box.home, '.kette', 'instances', 'uni');
  fs.chmodSync(path.join(idir, 'instance.json'), 0o444);
  try {
    const b = path.join(box.work, 'b');
    const r = ok(await kette(box, ['init', b, '--instance', 'uni', ...SETUP, '--no-plugins'], { ...rec('QA-09'), projects: [b] }), 1);
    assert.match(r.out, /instance\.json of instance uni is not writable.*Nothing in the project was changed/);
    assert.equal(exists(path.join(b, '.kette')), false);
  } finally {
    fs.chmodSync(path.join(idir, 'instance.json'), 0o644);
  }
});

test('CR-SEC-1, CR-SEC-2, CR-SEC-3: no token reaches instance.json or the screen, dangerous transports are refused without hanging', async () => {
  const box = sandbox();
  ok(await kette(box, ['update'], rec('security')));
  ok(await kette(box, ['instance', 'create', 'oss', '--edition', 'community'], rec('security')));
  const app = path.join(box.work, 'app');
  ok(await kette(box, ['init', app, ...SETUP, '--no-plugins'], { ...rec('security'), projects: [app] }));
  execFileSync('git', ['-C', app, 'remote', 'add', 'origin', 'https://x-access-token:ghp_SECRET123@github.com/acme/app.git'], { env: box.env });
  const use = ok(await kette(box, ['instance', 'use', 'oss', '--no-plugins'], { ...rec('security'), cwd: app }));
  const show = ok(await kette(box, ['instance', 'show', 'oss'], rec('security')));
  const file = fs.readFileSync(path.join(box.home, '.kette', 'instances', 'oss', 'instance.json'), 'utf8');
  for (const text of [use.out, show.out, file]) assert.doesNotMatch(text, /ghp_SECRET123|x-access-token/);
  assert.match(file, /"url": "https:\/\/github\.com\/acme\/app"/);
  const pwned = path.join(box.root, 'PWNED');
  ok(await kette(box, ['instance', 'create', 'evil', '--from', `ext::sh -c touch% ${pwned}`], rec('security')), 1);
  assert.equal(exists(pwned), false);
  const started = Date.now();
  const fd = ok(await kette(box, ['instance', 'create', 'fdx', '--from', 'fd::0'], rec('security')), 1);
  assert.ok(Date.now() - started < 30000, 'fd::0 does not wait for input');
  assert.match(fd.out, /git clone fd::0 failed/);
  const token = ok(await kette(box, ['instance', 'create', 'tok', '--from', 'https://user:hunter2@127.0.0.1:9/none.git'], rec('security')), 1);
  assert.doesNotMatch(token.out, /hunter2/);
  for (const n of ['fdx', 'tok', 'evil']) assert.equal(exists(path.join(box.home, '.kette', 'instances', n)), false, n);
});

test('CR-SEC-4: member ids with escape sequences are refused, printed text never carries control characters', async () => {
  const box = sandbox();
  ok(await kette(box, ['instance', 'create', 'oss', '--edition', 'community'], rec('security')));
  const r = ok(await kette(box, ['instance', 'members', 'add', 'evil\u001b[2J@example.com', '--instance', 'oss'], rec('security')), 2);
  assert.doesNotMatch(r.out, /\u001b/);
  assert.deepEqual(readInstanceFile(box, 'oss').members, []);
});

test('CR-MIG-1: a machine set up before 0.10 (legacy marketplace kette, user-scope plugins) gets the edition marketplace, the legacy stays', async () => {
  // As older versions left it: marketplace kette on bundles/active, kette-community of a draft on another folder under ~/.kette
  const box = sandbox({ registry: (home) => [{ name: 'kette', source: 'directory', path: path.join(home, '.kette', 'bundles', 'active') }, { name: 'kette-community', source: 'directory', path: path.join(home, '.kette', 'bundles', 'marketplace') }] });
  ok(await kette(box, ['login', KEY, '--no-npm'], rec('migration')));
  const userSettings = path.join(box.home, '.claude', 'settings.json');
  write(path.dirname(userSettings), 'settings.json', JSON.stringify({ theme: 'dark', enabledPlugins: { 'design-system-agents@kette': true, 'other@market': true } }));
  // From here the user scope holds the seeded legacy plugin on purpose, so steps check exit code and diff only
  const seeded = (r, code = 0) => { assert.equal(r.code, code, r.out); assert.deepEqual(r.outside, [], r.outside.join('\n')); return r; };
  seeded(await kette(box, ['instance', 'create', 'oss', '--edition', 'community'], rec('migration')));
  const app = path.join(box.work, 'app');
  const before = fs.readFileSync(userSettings, 'utf8');
  const r = seeded(await kette(box, ['init', app, '--instance', 'oss', ...SETUP], { ...rec('migration'), projects: [app], allow: CLAUDE_REGISTRY }));
  assert.doesNotMatch(r.out, /not enabled/);
  const calls = box.claude.calls();
  const rm = calls.indexOf('plugin marketplace remove kette-community');
  assert.ok(rm >= 0 && calls.indexOf(`plugin marketplace add --scope local ${path.join(box.home, '.kette', 'bundles', 'marketplace-community')}`) > rm, calls.join('\n'));
  assert.ok(!calls.includes('plugin marketplace remove kette'), 'the legacy marketplace stays for projects without settings');
  assert.equal(fs.readFileSync(userSettings, 'utf8'), before, 'kette never writes the user settings');
  assert.equal(settings(app)['design-system-agents@kette'], false, 'the legacy user-scope plugin is switched off in the project');
  assert.equal(settings(app)['ui-laws@kette-community'], true);
  const doctor = await kette(box, ['doctor'], { ...rec('migration'), cwd: app });
  assert.match(doctor.out, /user scope, set up by an older kette\): design-system-agents@kette/);
  // Removing a user-scope plugin of an older kette is the one change logout makes to the user settings
  const out = seeded(await kette(box, ['logout', '--no-npm'], { ...rec('migration'), cwd: app, allow: [/^\.claude\/settings\.json$/, ...CLAUDE_REGISTRY] }));
  assert.ok(box.claude.calls().includes('plugin uninstall design-system-agents@kette'));
  assert.deepEqual(JSON.parse(fs.readFileSync(userSettings, 'utf8')), { theme: 'dark', enabledPlugins: { 'other@market': true } }, 'only the legacy Enterprise plugin left the user settings');
  assert.deepEqual(out.userPlugins, [], 'after logout no Kette plugin is in the user scope');
  assert.doesNotMatch(out.out, /not removed/, 'QA-15: no failing uninstall for plugins that are not in the user scope');
});

test('QA-10, QA-11: a dangling instance link and a damaged instance can be removed, the name can be used again', { skip: posixOnly && 'renaming a linked folder needs POSIX semantics here' }, async () => {
  const box = sandbox();
  const team = instanceRepo(box, 'dang', 'community');
  const work = path.join(box.root, 'remote', 'dang-work');
  ok(await kette(box, ['instance', 'create', 'dang', '--from', work], rec('remove')));
  fs.renameSync(work, `${work}-moved`);
  const list = ok(await kette(box, ['instance', 'list'], rec('remove')));
  assert.match(list.out, /dang\s+damaged: link to .*, which is gone/);
  const again = ok(await kette(box, ['instance', 'create', 'dang', '--from', `${work}-moved`], rec('remove')), 1);
  assert.match(again.out, /is a link whose instance repo is gone\. Remove it with kette instance remove dang --yes/);
  ok(await kette(box, ['instance', 'remove', 'dang', '--yes'], rec('remove')));
  ok(await kette(box, ['instance', 'create', 'dang', '--from', `${work}-moved`], rec('remove')));
  assert.ok(exists(team));
});

test('QA-12, QA-13, QA-16, QA-17: pin checked per instance edition, missing instance and corrupt profile named, inherited overlays checked', async () => {
  const box = sandbox();
  const { ent, com } = await twoInstances(box, 'misc');
  for (const n of ['acme', 'oss']) {
    const f = path.join(box.home, '.kette', 'instances', n, 'instance.json');
    fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf8')), bundle: '0.19990101.1', overlays: [{ source: `github:${n}/rules` }] }, null, 2));
  }
  const dc = await kette(box, ['doctor'], { ...rec('misc'), cwd: com });
  assert.match(dc.out, /Instance oss pins bundle 0\.19990101\.1/, 'QA-12: Community instance on a licensed machine');
  assert.match(dc.out, /Overlay github:oss\/rules \(from instance oss\) is loaded by the agents/, 'QA-17');
  assert.match(fs.readFileSync(path.join(com, '.kette', 'README.md'), 'utf8'), /kette profile --effective/, 'QA-17: agents are told where inherited values are');
  const de = await kette(box, ['doctor'], { ...rec('misc'), cwd: ent });
  assert.match(de.out, /Instance acme pins bundle 0\.19990101\.1/);
  fs.writeFileSync(path.join(ent, '.kette', 'profile.json'), '{ broken');
  const di = ok(await kette(box, ['doctor', '--instance', 'acme'], rec('misc')), 1);
  assert.match(di.out, /FAIL ent: \.kette\/profile\.json is not readable/, 'QA-16');
  fs.rmSync(path.join(box.home, '.kette', 'instances', 'oss'), { recursive: true });
  const eff = ok(await kette(box, ['profile', '--effective'], { ...rec('misc'), cwd: com }), 1);
  assert.match(eff.out, /Instance oss not found on this machine/, 'QA-13');
});

test('QA-14: onboarding asks again after an answer that is not on the list, a taken name asks before joining', { skip: (posixOnly || spawnSync('python3', ['--version']).status !== 0) && 'needs python3 for a pseudo terminal' }, async () => {
  const box = sandbox();
  ok(await kette(box, ['update'], rec('onboarding')));
  ok(await kette(box, ['instance', 'create', 'team', '--edition', 'community'], rec('onboarding')));
  const flags = ['--no-plugins', '--stack', 'nestjs-prisma', '--platform', 'github-docker', '--patterns', 'layered'];
  const r = ok(await interactive(box, ['init', 'one', ...flags], [['Choose (numbers', '9'], ['Choose one number from 1 to 3', '3'], ['Name of the new instance', 'team'], ['exists already. Join it instead?', 'y'], ['Create these files?', 'y']]));
  assert.match(r.out, /Choose one number from 1 to 3\./);
  assert.equal(profile(path.join(box.work, 'one')).instance, 'team');
  assert.deepEqual(readInstanceFile(box, 'team').repos.map((x) => x.name), ['one']);
});

test('CR-TEST-1: the Enterprise plugins never reach the user scope on any platform, settings.local.json is git ignored', async () => {
  const box = sandbox();
  const { ent, com } = await twoInstances(box, 'platform');
  for (const d of [ent, com]) assert.match(fs.readFileSync(path.join(d, '.gitignore'), 'utf8'), /^\.claude\/settings\.local\.json$/m);
  for (const id of ENTERPRISE_ONLY) assert.equal(settings(com)[id], false, id);
  assert.equal(exists(path.join(box.home, '.claude', 'settings.json')), false);
});
