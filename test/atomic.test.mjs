import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmp, write } from './helpers.mjs';
import { CLAUDE_REGISTRY, KEY, NPMRC, SETUP, kette, ok, sandbox, start, stop } from './sandbox-harness.mjs';

// A kette killed while it writes a project file must leave the old file (or the new one), never an empty or half one.
// The hook below plays the CI failure deterministically: when kette opens a file whose name holds KETTE_TEST_KILL_ON inside
// KETTE_TEST_KILL_IN for writing, the file is truncated and the process kills itself with SIGKILL (only its own PID)
before(start);
after(() => stop('atomic'));

const hookDir = tmp();
write(hookDir, 'kill-hook.mjs', `import fs from 'node:fs';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
const name = process.env.KETTE_TEST_KILL_ON;
const dir = process.env.KETTE_TEST_KILL_IN;
const hit = (p) => typeof p === 'string' && path.resolve(p).startsWith(dir) && path.basename(p).includes(name);
const die = () => process.kill(process.pid, 'SIGKILL');
const open = fs.openSync;
fs.openSync = function (p, flags, ...rest) { const fd = open.call(this, p, flags, ...rest); if (hit(p) && /[wa]/.test(String(flags))) die(); return fd; };
const write = fs.writeFileSync;
fs.writeFileSync = function (p, ...rest) { if (hit(p)) { fs.closeSync(open(p, 'w')); die(); } return write.call(this, p, ...rest); };
syncBuiltinESMExports();
`);
const HOOK = ['--import', pathToFileURL(path.join(hookDir, 'kill-hook.mjs')).href];

// Runs one kette command with the kill hook on file in repo, then checks that the file is byte for byte what it was before
async function killedWhileWriting(box, repo, file, argv, allow = CLAUDE_REGISTRY) {
  const target = path.join(repo, file);
  const before = fs.readFileSync(target, 'utf8');
  const r = await kette(box, argv, { cwd: repo, allow, node: HOOK, env: { KETTE_TEST_KILL_ON: path.basename(file), KETTE_TEST_KILL_IN: fs.realpathSync(path.dirname(target)) } });
  assert.notEqual(r.code, 0, `${file}: the hook must have killed kette\n${r.out}`);
  assert.equal(fs.readFileSync(target, 'utf8'), before, `${file} is unchanged after the kill, not empty or half written`);
  return r;
}

test('a kette killed while writing a project file leaves it whole: profile, README block, settings, local settings, .npmrc, templates record', async () => {
  const box = sandbox();
  ok(await kette(box, ['login', KEY], { allow: NPMRC }));
  ok(await kette(box, ['instance', 'create', 'acme', '--edition', 'enterprise']));
  ok(await kette(box, ['instance', 'create', 'oss', '--edition', 'community']));
  const app = path.join(box.work, 'app');
  ok(await kette(box, ['init', app, '--instance', 'acme', ...SETUP], { projects: [app], allow: CLAUDE_REGISTRY }));
  write(app, '.npmrc', `save-exact=true\n${fs.readFileSync(path.join(app, '.npmrc'), 'utf8')}`);
  // A template changed by hand stays recorded, so leaving Enterprise rewrites .kette/templates.json instead of removing it
  fs.appendFileSync(path.join(app, 'compose.yaml'), '# mine\n');
  // Joining a Community instance rewrites every one of them, in this order; each run is killed at the next file
  for (const file of ['.kette/profile.json', '.kette/README.md', '.claude/settings.json', '.claude/settings.local.json', '.npmrc', '.kette/templates.json']) {
    await killedWhileWriting(box, app, file, ['instance', 'use', 'oss']);
  }
  // After the kills the next run finishes and no temp file of a killed run stays in the project
  ok(await kette(box, ['instance', 'use', 'oss'], { cwd: app, allow: CLAUDE_REGISTRY }));
  assert.equal(JSON.parse(fs.readFileSync(path.join(app, '.kette', 'profile.json'), 'utf8')).instance, 'oss');
  assert.equal(fs.readFileSync(path.join(app, '.npmrc'), 'utf8'), 'save-exact=true\n');
  const temps = fs.readdirSync(app, { recursive: true }).filter((n) => /\.\d+\.[0-9a-f]+\.tmp$/.test(String(n)));
  assert.deepEqual(temps, []);
});

test('a kette killed while writing the wallet keeps .kette/wallet.json whole', async () => {
  const box = sandbox();
  ok(await kette(box, ['login', KEY, '--no-npm']));
  const app = path.join(box.work, 'app');
  ok(await kette(box, ['init', app, ...SETUP], { projects: [app], allow: CLAUDE_REGISTRY }));
  ok(await kette(box, ['wallet', 'init', '--yes'], { cwd: app }));
  await killedWhileWriting(box, app, '.kette/wallet.json', ['wallet', 'add', 'NEW_SECRET', '--env', 'dev'], []);
});
