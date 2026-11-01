import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { write } from './helpers.mjs';
import { CLAUDE_REGISTRY, ENTERPRISE_ONLY, KEY, MCP_USER, NPMRC, SETUP, instanceRepo, interactive, kette, ok, profile, readInstanceFile, sandbox, settings, start, stop } from './sandbox-harness.mjs';

before(start);
after(() => stop('sandbox'));

test('every command of the help runs in a sandbox and changes nothing global outside the allowed list', async () => {
  const box = sandbox();
  const step = (argv, opts = {}) => kette(box, argv, { record: 'all-commands', ...opts });
  const app = path.join(box.work, 'app');
  ok(await step(['version']));
  ok(await step(['help']));
  ok(await step(['state']));
  ok(await step(['update']));
  ok(await step(['doctor']));
  ok(await step(['init', app, ...SETUP], { projects: [app], allow: CLAUDE_REGISTRY }));
  ok(await step(['add', ...SETUP], { cwd: app, allow: CLAUDE_REGISTRY }));
  ok(await step(['doctor'], { cwd: app }));
  ok(await step(['doctor', '--ci'], { cwd: app }));
  ok(await step(['rules'], { cwd: app }));
  ok(await step(['rules', '--path'], { cwd: app }));
  ok(await step(['profile'], { cwd: app }));
  ok(await step(['profile', '--effective'], { cwd: app }));
  ok(await step(['theme', '--primary', '#3366ff', '--out', 'theme.css'], { cwd: app }));
  ok(await step(['cloud', 'status'], { cwd: app }));
  ok(await step(['cloud', 'setup', '--have-account', '--dcr'], { cwd: app, allow: MCP_USER }));
  ok(await step(['login', KEY], { cwd: app, allow: [...NPMRC, ...CLAUDE_REGISTRY] }));
  ok(await step(['token', 'ci', 'create', 'pipeline'], { cwd: app }));
  ok(await step(['token', 'ci', 'list'], { cwd: app }));
  ok(await step(['token', 'ci', 'revoke', '00000000-0000-4000-8000-000000000001'], { cwd: app }));
  ok(await step(['figma', '--out', 'figma'], { cwd: app }));
  ok(await step(['project'], { cwd: app }));
  ok(await step(['project', 'list'], { cwd: app }));
  ok(await step(['project', 'create', 'acme', '--edition', 'enterprise'], { cwd: app }));
  ok(await step(['project', 'show', 'acme'], { cwd: app }));
  ok(await step(['project', 'members', 'add', 'alex@example.com', '--role', 'owner', '--project', 'acme'], { cwd: app }));
  ok(await step(['project', 'members', '--project', 'acme'], { cwd: app }));
  ok(await step(['project', 'members', 'remove', 'alex@example.com', '--project', 'acme'], { cwd: app }));
  ok(await step(['project', 'use', 'acme'], { cwd: app, allow: CLAUDE_REGISTRY }));
  ok(await step(['project', 'add-repo', app, '--project', 'acme'], { cwd: app }));
  ok(await step(['doctor', '--project'], { cwd: app }));
  ok(await step(['wallet', 'help'], { cwd: app }));
  ok(await step(['wallet', 'init', '--yes'], { cwd: app }));
  ok(await step(['wallet', 'status'], { cwd: app }));
  ok(await step(['wallet', 'add', 'API_KEY', '--env', 'dev'], { cwd: app }));
  ok(await step(['wallet', 'set', 'API_KEY', '--env', 'dev', '--stdin'], { cwd: app, input: 'secret-value\n' }));
  write(app, '.env', 'DATABASE_URL=postgres://localhost\n');
  ok(await step(['wallet', 'import', '.env', '--env', 'dev', '--yes'], { cwd: app }));
  ok(await step(['wallet', 'run', '--env', 'dev', '--', process.execPath, '-e', 'process.exit(process.env.API_KEY ? 0 : 3)'], { cwd: app }));
  ok(await step(['wallet', 'sync', 'github', '--env', 'dev', '--repo', 'owner/name', '--yes'], { cwd: app }));
  ok(await step(['wallet', 'trust'], { cwd: app }));
  ok(await step(['wallet', 'remove', 'API_KEY'], { cwd: app }));
  ok(await step(['update'], { cwd: app, allow: [...NPMRC, ...CLAUDE_REGISTRY] }));
  ok(await step(['project', 'create', 'scratch', '--edition', 'community'], { cwd: app }));
  ok(await step(['project', 'remove', 'scratch', '--yes'], { cwd: app }));
  ok(await step(['logout'], { cwd: app, allow: [...NPMRC, ...CLAUDE_REGISTRY] }));
  assert.equal(fs.existsSync(path.join(box.home, '.claude', 'settings.json')), false, 'the user settings of Claude Code were never written');
});

test('two repos in an Enterprise and a Community instance on one machine do not see each other', async () => {
  const box = sandbox();
  const [ent, com] = [path.join(box.work, 'ent'), path.join(box.work, 'com')];
  const rec = { record: 'two-instances' };
  ok(await kette(box, ['login', KEY, '--no-plugins', '--no-npm'], rec));
  ok(await kette(box, ['project', 'create', 'acme', '--edition', 'enterprise'], rec));
  ok(await kette(box, ['project', 'create', 'oss', '--edition', 'community'], rec));
  ok(await kette(box, ['init', ent, '--project', 'acme', ...SETUP], { ...rec, projects: [ent], allow: CLAUDE_REGISTRY }));
  ok(await kette(box, ['init', com, '--project', 'oss', ...SETUP], { ...rec, projects: [com], allow: CLAUDE_REGISTRY }));
  assert.deepEqual(readInstanceFile(box, 'acme').repos.map((r) => r.name), ['ent']);
  assert.deepEqual(readInstanceFile(box, 'oss').repos.map((r) => r.name), ['com']);
  for (const id of ENTERPRISE_ONLY) { assert.equal(settings(ent)[id], true, id); assert.equal(settings(com)[id], false, id); }
  assert.equal(settings(com)['ui-laws@kette-community'], true);
  assert.equal(profile(ent).tier, 'enterprise');
  assert.equal(profile(com).tier, 'community');
  assert.match(fs.readFileSync(path.join(ent, '.kette', 'README.md'), 'utf8'), /kette-engineering:code-reviewer/);
  assert.doesNotMatch(fs.readFileSync(path.join(com, '.kette', 'README.md'), 'utf8'), /design-system-agents/);
  ok(await kette(box, ['doctor'], { ...rec, cwd: ent }));
  ok(await kette(box, ['doctor'], { ...rec, cwd: com }));
  const show = ok(await kette(box, ['project', 'show', 'oss'], { ...rec, cwd: com }));
  assert.doesNotMatch(show.out, /\bent\b/);
  // claude install calls of the Community repo name Community plugins only
  const comCalls = box.claude.calls().filter((c, i) => fs.realpathSync(box.claude.cwds()[i]) === com && c.startsWith('plugin install'));
  assert.ok(comCalls.length && comCalls.every((c) => /kette-engineering-core|ui-laws/.test(c)), comCalls.join('\n'));
});

test('a repo switches instance: edition, settings and note follow, it leaves the old instance', async () => {
  const box = sandbox();
  const app = path.join(box.work, 'app');
  const rec = { record: 'switch-instance' };
  ok(await kette(box, ['login', KEY, '--no-plugins', '--no-npm'], rec));
  ok(await kette(box, ['project', 'create', 'acme', '--edition', 'enterprise'], rec));
  ok(await kette(box, ['project', 'create', 'oss', '--edition', 'community'], rec));
  ok(await kette(box, ['init', app, '--project', 'acme', ...SETUP], { ...rec, projects: [app], allow: CLAUDE_REGISTRY }));
  ok(await kette(box, ['project', 'use', 'oss'], { ...rec, cwd: app, allow: CLAUDE_REGISTRY }));
  assert.equal(profile(app).instance, 'oss');
  assert.equal(profile(app).tier, 'community');
  assert.equal(settings(app)['design-system-agents@kette-enterprise'], false);
  assert.doesNotMatch(fs.readFileSync(path.join(app, '.kette', 'README.md'), 'utf8'), /design-system-agents:requirements-engineer/);
  assert.deepEqual(readInstanceFile(box, 'acme').repos, []);
  assert.deepEqual(readInstanceFile(box, 'oss').repos.map((r) => r.name), ['app']);
  ok(await kette(box, ['project', 'use', 'acme'], { ...rec, cwd: app, allow: CLAUDE_REGISTRY }));
  assert.equal(profile(app).tier, 'enterprise');
  assert.equal(settings(app)['design-system-agents@kette-enterprise'], true);
  ok(await kette(box, ['doctor'], { ...rec, cwd: app }));
});

test('a repo without instance works as before: machine edition, profile without instance, plugins in the project', async () => {
  const box = sandbox();
  const app = path.join(box.work, 'app');
  const rec = { record: 'no-instance' };
  ok(await kette(box, ['init', app, ...SETUP], { ...rec, projects: [app], allow: CLAUDE_REGISTRY }));
  const p = profile(app);
  assert.equal('instance' in p, false);
  assert.equal(p.tier, 'community');
  assert.equal(settings(app)['kette-engineering-core@kette-community'], true);
  ok(await kette(box, ['add', ...SETUP], { ...rec, cwd: app, allow: CLAUDE_REGISTRY }));
  ok(await kette(box, ['doctor'], { ...rec, cwd: app }));
  ok(await kette(box, ['login', KEY, '--no-npm'], { ...rec, cwd: app, allow: CLAUDE_REGISTRY }));
  // ADR-0001 still holds without an instance: add raises the project to the machine edition
  ok(await kette(box, ['add', ...SETUP], { ...rec, cwd: app, allow: CLAUDE_REGISTRY }));
  assert.equal(profile(app).tier, 'enterprise');
  assert.equal(settings(app)['design-review-pack@kette-enterprise'], true);
});

test('an Enterprise instance without licence stops with a clear message and writes nothing', async () => {
  const box = sandbox();
  const app = path.join(box.work, 'app');
  const rec = { record: 'enterprise-no-licence' };
  const create = ok(await kette(box, ['project', 'create', 'acme', '--edition', 'enterprise'], rec), 1);
  assert.match(create.out, /Kette project acme is Enterprise \(Die Kette\), this machine has no valid licence\. Sign in with: kette login <key>/);
  assert.equal(fs.existsSync(path.join(box.home, '.kette', 'instances', 'acme')), false);
  // An Enterprise instance from a teammate's repo is refused and its clone removed again
  const repo = instanceRepo(box, 'acme', 'enterprise');
  const clone = ok(await kette(box, ['project', 'create', 'acme', '--from', repo], rec), 1);
  assert.match(clone.out, /no valid licence/);
  assert.equal(fs.existsSync(path.join(box.home, '.kette', 'instances', 'acme')), false);
  // A licence that is gone again: the instance stays, add and doctor say what is missing
  ok(await kette(box, ['login', KEY, '--no-plugins', '--no-npm'], rec));
  ok(await kette(box, ['project', 'create', 'acme', '--edition', 'enterprise'], rec));
  ok(await kette(box, ['init', app, '--project', 'acme', ...SETUP], { ...rec, projects: [app], allow: CLAUDE_REGISTRY }));
  ok(await kette(box, ['logout', '--no-npm'], { ...rec, cwd: app, allow: CLAUDE_REGISTRY }));
  const add = ok(await kette(box, ['add', ...SETUP], { ...rec, cwd: app }), 1);
  assert.match(add.out, /Kette project acme is Enterprise \(Die Kette\), this machine has no valid licence/);
  const doctor = ok(await kette(box, ['doctor'], { ...rec, cwd: app }), 1);
  assert.match(doctor.out, /FAIL Kette project acme is Enterprise, this machine has no valid licence\. Sign in with: kette login <key>/);
});

test('a Community instance on a machine with a licence never enables Enterprise plugins or features', async () => {
  const box = sandbox();
  const app = path.join(box.work, 'app');
  const rec = { record: 'community-with-licence' };
  ok(await kette(box, ['login', KEY], { ...rec, allow: NPMRC }));
  ok(await kette(box, ['project', 'create', 'oss', '--edition', 'community'], rec));
  const before = box.claude.calls().length;
  ok(await kette(box, ['init', app, '--project', 'oss', ...SETUP], { ...rec, projects: [app], allow: CLAUDE_REGISTRY }));
  const installs = box.claude.calls().slice(before).filter((c) => c.startsWith('plugin install'));
  assert.deepEqual(installs.sort(), ['plugin install kette-engineering-core@kette-community --scope project', 'plugin install ui-laws@kette-community --scope project']);
  for (const id of ENTERPRISE_ONLY) assert.equal(settings(app)[id], false, id);
  assert.equal(fs.existsSync(path.join(app, '.npmrc')), false, 'no Enterprise registry line');
  assert.equal(fs.existsSync(path.join(app, '.github')), false, 'no Enterprise templates');
  const w = ok(await kette(box, ['wallet', 'init', '--yes'], { ...rec, cwd: app }), 1);
  assert.match(w.out, /The secret wallet is part of Enterprise/);
  ok(await kette(box, ['doctor'], { ...rec, cwd: app }));
});

test('login, update and logout with several instances keep every repo in its scope', async () => {
  const box = sandbox();
  const [ent, com] = [path.join(box.work, 'ent'), path.join(box.work, 'com')];
  const rec = { record: 'login-update-logout' };
  ok(await kette(box, ['update'], rec));
  ok(await kette(box, ['project', 'create', 'oss', '--edition', 'community'], rec));
  ok(await kette(box, ['init', com, '--project', 'oss', ...SETUP], { ...rec, projects: [com], allow: CLAUDE_REGISTRY }));
  write(ent, '.keep', '');
  ok(await kette(box, ['login', KEY, '--no-npm'], { ...rec, cwd: com, allow: CLAUDE_REGISTRY }));
  assert.equal(settings(com)['design-system-agents@kette-enterprise'], false, 'login in a Community repo keeps it Community');
  ok(await kette(box, ['project', 'create', 'acme', '--edition', 'enterprise'], rec));
  ok(await kette(box, ['init', ent, '--project', 'acme', ...SETUP], { ...rec, projects: [ent], allow: CLAUDE_REGISTRY }));
  ok(await kette(box, ['update', '--no-npm'], { ...rec, cwd: com, allow: CLAUDE_REGISTRY }));
  ok(await kette(box, ['update', '--no-npm'], { ...rec, cwd: ent, allow: CLAUDE_REGISTRY }));
  const market = (edition) => path.join(box.home, '.kette', 'bundles', `marketplace-${edition}`, 'plugins');
  assert.deepEqual(fs.readdirSync(market('community')).sort(), ['kette-engineering-core', 'ui-laws']);
  assert.deepEqual(fs.readdirSync(market('enterprise')).sort(), ['design-review-pack', 'design-system-agents', 'kette-engineering', 'kette-engineering-core', 'kette-ticketing']);
  ok(await kette(box, ['doctor'], { ...rec, cwd: ent }));
  ok(await kette(box, ['doctor'], { ...rec, cwd: com }));
  ok(await kette(box, ['logout', '--no-npm'], { ...rec, cwd: com, allow: CLAUDE_REGISTRY }));
  assert.equal(fs.existsSync(market('enterprise')), false, 'the Enterprise marketplace goes with the licence');
  assert.deepEqual(fs.readdirSync(market('community')).sort(), ['kette-engineering-core', 'ui-laws']);
  ok(await kette(box, ['doctor'], { ...rec, cwd: com }));
  ok(await kette(box, ['doctor'], { ...rec, cwd: ent }), 1);
});

test('doctor --instance checks every repo and names a broken one', async () => {
  const box = sandbox();
  const rec = { record: 'doctor-instance-broken' };
  const [good, gone, moved] = ['good', 'gone', 'moved'].map((n) => path.join(box.work, n));
  ok(await kette(box, ['project', 'create', 'oss', '--edition', 'community'], rec));
  for (const dir of [good, gone, moved]) ok(await kette(box, ['init', dir, '--project', 'oss', ...SETUP], { ...rec, projects: [dir], allow: CLAUDE_REGISTRY }));
  fs.rmSync(gone, { recursive: true });
  const p = profile(moved);
  fs.writeFileSync(path.join(moved, '.kette', 'profile.json'), JSON.stringify({ ...p, instance: 'other' }, null, 2));
  const r = ok(await kette(box, ['doctor', '--project', 'oss'], rec), 1);
  assert.match(r.out, /FAIL .*gone is gone\. Check it out again/);
  assert.match(r.out, /FAIL moved uses Kette project other\. Fix in the repo with: kette project use oss/);
  assert.match(r.out, /Kette project oss: 1 of 3 repos all good/);
});

test('an instance from a git repo is cloned, its settings are inherited, kette never deletes it', async () => {
  const box = sandbox();
  const app = path.join(box.work, 'app');
  const rec = { record: 'instance-from-git' };
  const repo = instanceRepo(box, 'team', 'community');
  ok(await kette(box, ['project', 'create', 'team', '--from', repo], rec));
  const dir = path.join(box.home, '.kette', 'instances', 'team');
  assert.ok(fs.existsSync(path.join(dir, '.git')));
  ok(await kette(box, ['init', app, '--project', 'team', ...SETUP], { ...rec, projects: [app], allow: CLAUDE_REGISTRY }));
  const eff = JSON.parse(ok(await kette(box, ['profile', '--effective'], { ...rec, cwd: app })).out);
  assert.deepEqual(eff.ticketing, { adapter: 'workbase', project: 'ZERO' });
  assert.equal(eff.stack[0], 'nestjs-prisma', 'repo values stay');
  const member = ok(await kette(box, ['project', 'members', 'add', 'dev@example.com', '--project', 'team'], rec));
  assert.match(member.out, /Commit and push the change so the team and agents see it/);
  const rm = ok(await kette(box, ['project', 'remove', 'team', '--yes'], rec), 1);
  assert.match(rm.out, /kette never deletes a Kette project repo/);
  assert.ok(fs.existsSync(path.join(dir, 'instance.json')));
  // A linked folder: remove drops only the link
  const linked = path.join(box.root, 'remote', 'team-work');
  ok(await kette(box, ['project', 'create', 'team-link', '--from', linked], rec), 1);
  fs.writeFileSync(path.join(linked, 'instance.json'), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(linked, 'instance.json'), 'utf8')), name: 'team-link' }));
  ok(await kette(box, ['project', 'create', 'team-link', '--from', linked], rec));
  ok(await kette(box, ['project', 'remove', 'team-link'], rec), 1);
  ok(await kette(box, ['project', 'remove', 'team-link', '--yes'], rec));
  assert.ok(fs.existsSync(path.join(linked, 'instance.json')), 'the linked instance repo stays');
});

test('onboarding: kette init in a terminal asks for the instance, creates a new one or picks an existing one', { skip: (process.platform === 'win32' || spawnSync('python3', ['--version']).status !== 0) && 'needs python3 for a pseudo terminal' }, async () => {
  const box = sandbox();
  ok(await kette(box, ['update'], { record: 'onboarding' }));
  const flags = ['--no-plugins', '--stack', 'nestjs-prisma', '--platform', 'github-docker', '--patterns', 'layered'];
  const fresh = ok(await interactive(box, ['init', 'one', ...flags], [['Choose (numbers', '2'], ['Name of the new Kette project', 'team'], ['Choose (numbers', '1'], ['Create these files?', 'y']]));
  assert.match(fresh.out, /Which Kette project does this repo belong to\?/);
  assert.equal(profile(path.join(box.work, 'one')).instance, 'team');
  assert.equal(readInstanceFile(box, 'team').edition, 'community');
  assert.deepEqual(readInstanceFile(box, 'team').repos.map((r) => r.name), ['one']);
  const pick = ok(await interactive(box, ['init', 'two', ...flags], [['Choose (numbers', '2'], ['Create these files?', 'y']]));
  assert.match(pick.out, /2\) Kette project team \(Community\)/);
  assert.equal(profile(path.join(box.work, 'two')).instance, 'team');
  ok(await interactive(box, ['init', 'three', ...flags], [['Choose (numbers', '1'], ['Create these files?', 'y']]));
  assert.equal('instance' in profile(path.join(box.work, 'three')), false, 'none keeps the old behaviour');
  // A connected project is not asked again
  const again = ok(await kette(box, ['add', '--no-plugins', ...flags.slice(1), '--yes'], { cwd: path.join(box.work, 'one'), record: 'onboarding' }));
  assert.doesNotMatch(again.out, /Which Kette project/);
});

test('KETTE-46: kette instance and --instance of 0.11 keep working as hidden aliases, the help says Kette project', async () => {
  const box = sandbox();
  const rec = { record: 'aliases' };
  const app = path.join(box.work, 'app');
  // instance.json is the file name on disk and stays (ADR-0002, decision 25); no other word instance in the help
  const word = /\binstance\b(?!\.json)/i;
  for (const argv of [['help'], ['project'], ['instance']]) {
    const r = ok(await kette(box, argv, rec));
    assert.doesNotMatch(r.out, word, argv.join(' '));
    assert.match(r.out, /kette project create <name>/);
  }
  ok(await kette(box, ['instance', 'create', 'old', '--edition', 'community'], rec));
  assert.match(ok(await kette(box, ['instance', 'list'], rec)).out, /old/);
  ok(await kette(box, ['init', app, '--instance', 'old', ...SETUP], { ...rec, projects: [app], allow: CLAUDE_REGISTRY }));
  assert.equal(profile(app).instance, 'old', 'the profile field keeps its 0.11 name');
  assert.deepEqual(readInstanceFile(box, 'old').repos.map((r) => r.name), ['app']);
  const doc = ok(await kette(box, ['doctor', '--instance', 'old'], { ...rec, cwd: app }));
  assert.match(doc.out, /Kette project old: 1 of 1 repo all good/);
  assert.match(ok(await kette(box, ['instance', 'show'], { ...rec, cwd: app })).out, /Kette project +old/);
  // CR-TEST-1: the other subcommands under the alias, with --instance as the name
  ok(await kette(box, ['instance', 'members', 'add', 'lead@old.test', '--role', 'owner', '--instance', 'old'], rec));
  assert.match(ok(await kette(box, ['instance', 'members', '--instance', 'old'], rec)).out, /lead@old\.test owner/);
  ok(await kette(box, ['instance', 'members', 'remove', 'lead@old.test', '--instance', 'old'], rec));
  assert.deepEqual(readInstanceFile(box, 'old').members, []);
  ok(await kette(box, ['instance', 'create', 'newer', '--edition', 'community'], rec));
  const moved = ok(await kette(box, ['instance', 'add-repo', app, '--instance', 'newer'], { ...rec, cwd: app }));
  assert.match(moved.out, /app removed from Kette project old/);
  assert.deepEqual(readInstanceFile(box, 'newer').repos.map((r) => r.name), ['app']);
  const used = ok(await kette(box, ['instance', 'use', 'newer'], { ...rec, cwd: app, allow: CLAUDE_REGISTRY }));
  assert.match(used.out, /This repo now uses Kette project newer \(Community\)/);
  assert.equal(profile(app).instance, 'newer');
  ok(await kette(box, ['instance', 'use', 'old'], { ...rec, cwd: app, allow: CLAUDE_REGISTRY }));
  const unknown = ok(await kette(box, ['project', 'rename'], rec), 2);
  assert.match(unknown.out, /Unknown project command: rename\. Usage: kette project create/);
  ok(await kette(box, ['instance', 'remove', 'old', '--yes'], rec));
});
