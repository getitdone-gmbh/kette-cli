import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { tmp, write } from './helpers.mjs';

// Several real processes on one lock name (CR-NEW-7, CR-NEW-9): every increment of a counter file must count, no lock may stay behind
const LOCK = pathToFileURL(path.resolve('src/lock.mjs')).href;

function worker(dir) {
  const f = path.join(dir, 'worker.mjs');
  write(dir, 'worker.mjs', `import fs from 'node:fs';
import { withLock } from ${JSON.stringify(LOCK)};
const [counter, rounds, hold] = process.argv.slice(2);
for (let i = 0; i < Number(rounds); i++) {
  withLock('c', () => {
    const n = Number(fs.readFileSync(counter, 'utf8'));
    fs.writeFileSync(counter, String(n + 1));
    // hold: keep the lock until killed, so a test can kill a holder in the middle of its work
    if (hold) { fs.writeFileSync(hold, 'held'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600000); }
  });
}
`);
  return f;
}

// node: options for node itself, such as a hook that plays a drive or a pause
const run = (script, args, env, node = []) => new Promise((resolve) => {
  const c = spawn(process.execPath, [...node, script, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  c.stdout.on('data', (x) => { out += x; });
  c.stderr.on('data', (x) => { out += x; });
  c.on('close', (code) => resolve({ code, out }));
});

function setup() {
  const home = tmp();
  const dir = tmp();
  const counter = path.join(dir, 'counter');
  fs.writeFileSync(counter, '0');
  return { home, counter, script: worker(dir), env: { ...process.env, KETTE_HOME: home } };
}

const leftovers = (home) => (fs.existsSync(path.join(home, 'locks')) ? fs.readdirSync(path.join(home, 'locks')) : []);

for (const n of [4, 8]) {
  test(`CR-NEW-7: ${n} processes x 100 withLock on one name count every increment, no lock stays`, { timeout: 120000 }, async () => {
    const { home, counter, script, env } = setup();
    const started = Date.now();
    const rs = await Promise.all(Array.from({ length: n }, () => run(script, [counter, '100'], env)));
    assert.deepEqual(rs.map((r) => r.code), Array(n).fill(0), rs.map((r) => r.out).join('\n'));
    assert.equal(Number(fs.readFileSync(counter, 'utf8')), n * 100);
    assert.deepEqual(leftovers(home), []);
    assert.ok(Date.now() - started < 30000, 'no waiter ran into the 30 s timeout');
  });
}

test('CR-NEW-7: a holder killed with SIGKILL in the middle is taken over, the others count on', { timeout: 120000 }, async () => {
  const { home, counter, script, env } = setup();
  const hold = path.join(path.dirname(counter), 'held');
  const holder = spawn(process.execPath, [script, counter, '1', hold], { env, stdio: 'ignore' });
  for (let i = 0; i < 400 && !fs.existsSync(hold); i++) await new Promise((r) => setTimeout(r, 25));
  assert.ok(fs.existsSync(hold), 'the holder got the lock');
  const workers = Array.from({ length: 4 }, () => run(script, [counter, '50'], env));
  await new Promise((r) => setTimeout(r, 100));
  // Only the PID of the child this test started is killed
  holder.kill('SIGKILL');
  await new Promise((r) => holder.on('close', r));
  const rs = await Promise.all(workers);
  assert.deepEqual(rs.map((r) => r.code), [0, 0, 0, 0], rs.map((r) => r.out).join('\n'));
  assert.equal(Number(fs.readFileSync(counter, 'utf8')), 1 + 200);
  assert.deepEqual(leftovers(home), []);
});

test('CR-NEW-7: a claim left by a holder that died while releasing does not block for long', { timeout: 120000 }, async () => {
  const { home, counter, script, env } = setup();
  const locks = path.join(home, 'locks');
  fs.mkdirSync(locks, { recursive: true });
  const dead = spawn(process.execPath, ['-e', 'console.log(process.pid)'], { stdio: ['ignore', 'pipe', 'ignore'] });
  const pid = await new Promise((resolve) => { let o = ''; dead.stdout.on('data', (x) => { o += x; }); dead.on('close', () => resolve(Number(o.trim()))); });
  // The state a SIGKILL during release leaves: the lock of a dead owner and its claim, both made 11 s ago
  const lock = path.join(locks, 'c.lck');
  fs.writeFileSync(lock, JSON.stringify({ pid, at: Date.now() - 11000, token: 'gone' }));
  fs.linkSync(lock, `${lock}.gone.claim`);
  const past = new Date(Date.now() - 11000);
  fs.utimesSync(lock, past, past);
  const started = Date.now();
  const rs = await Promise.all(Array.from({ length: 2 }, () => run(script, [counter, '20'], env)));
  assert.deepEqual(rs.map((r) => r.code), [0, 0], rs.map((r) => r.out).join('\n'));
  assert.equal(Number(fs.readFileSync(counter, 'utf8')), 40);
  assert.ok(Date.now() - started < 30000);
  assert.deepEqual(leftovers(home), []);
});

test('CR-NEW-7: removing a lock that another process removed first is no error', async () => {
  const { removeIfToken, lockFile } = await import('../src/lock.mjs');
  process.env.KETTE_HOME = tmp();
  fs.mkdirSync(path.dirname(lockFile('gone')), { recursive: true });
  assert.equal(removeIfToken(lockFile('gone'), 'any'), false);
});

test('KETTE-29: withLockAsync holds the lock until the async work is done', async () => {
  const { withLockAsync, lockFile } = await import('../src/lock.mjs');
  const fsMod = await import('node:fs');
  let seen = null;
  await withLockAsync('async-probe', async () => {
    await new Promise((r) => setTimeout(r, 20));
    seen = fsMod.existsSync(lockFile('async-probe'));
  });
  assert.equal(seen, true, 'the lock file exists while the work runs');
  assert.equal(fsMod.existsSync(lockFile('async-probe')), false, 'released afterwards');
});

// Fix round 4 of the lock (KETTE-21, docs/adr/0002 decision 21)
const deadPid = async () => {
  const c = spawn(process.execPath, ['-e', 'console.log(process.pid)'], { stdio: ['ignore', 'pipe', 'ignore'] });
  return new Promise((resolve) => { let o = ''; c.stdout.on('data', (x) => { o += x; }); c.on('close', () => resolve(Number(o.trim()))); });
};
const locksOf = (home) => { const d = path.join(home, 'locks'); fs.mkdirSync(d, { recursive: true }); return d; };
const aged = (file, ms) => { const t = new Date(Date.now() - ms); fs.utimesSync(file, t, t); };
const hookDir = tmp();
const hook = (name, code) => { write(hookDir, name, `import fs from 'node:fs';\nimport { syncBuiltinESMExports } from 'node:module';\n${code}\nsyncBuiltinESMExports();\n`); return ['--import', pathToFileURL(path.join(hookDir, name)).href]; };
const runNode = (node, script, args, env) => run(script, args, env, node);

// Each round writes in and out with its pid, so two holders at the same time show up as in, in
function overlapWorker(dir) {
  write(dir, 'overlap.mjs', `import fs from 'node:fs';
import { withLock } from ${JSON.stringify(LOCK)};
const [log, holdMs] = process.argv.slice(2);
withLock('c', () => {
  fs.appendFileSync(log, 'in ' + process.pid + '\\n');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(holdMs));
  fs.appendFileSync(log, 'out ' + process.pid + '\\n');
});
`);
  return path.join(dir, 'overlap.mjs');
}
const noOverlap = (log) => {
  const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
  for (let i = 0; i < lines.length; i += 2) assert.deepEqual([lines[i].split(' ')[0], lines[i + 1]?.split(' ')[0], lines[i + 1]?.split(' ')[1]], ['in', 'out', lines[i].split(' ')[1]], `one holder at a time:\n${lines.join('\n')}`);
  return lines.length / 2;
};

test('CR-NEW-10: a claimant paused for over 10 s keeps its claim, so nobody deletes the lock that follows', { timeout: 120000 }, async () => {
  const home = tmp();
  const dir = tmp();
  const log = path.join(dir, 'log');
  fs.writeFileSync(log, '');
  const marker = path.join(dir, 'paused');
  fs.writeFileSync(path.join(locksOf(home), 'c.lck'), JSON.stringify({ pid: await deadPid(), at: Date.now(), token: 'gone' }));
  // The claimant stops for 12 s right before it unlinks the lock it checked, like a laptop that sleeps in the middle
  const paused = hook('pause-unlink.mjs', `const unlink = fs.unlinkSync;
let done = false;
fs.unlinkSync = function (p) {
  if (!done && String(p).endsWith('.lck')) { done = true; fs.writeFileSync(process.env.KETTE_TEST_PAUSED, ''); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 12000); }
  return unlink.call(this, p);
};`);
  const script = overlapWorker(dir);
  const env = { ...process.env, KETTE_HOME: home, KETTE_TEST_PAUSED: marker };
  const sleeper = runNode(paused, script, [log, '0'], env);
  for (let i = 0; i < 800 && !fs.existsSync(marker); i++) await new Promise((r) => setTimeout(r, 25));
  assert.ok(fs.existsSync(marker), 'the claimant paused');
  await new Promise((r) => setTimeout(r, 10500));
  const rs = await Promise.all([sleeper, runNode([], script, [log, '3000'], { ...process.env, KETTE_HOME: home })]);
  assert.deepEqual(rs.map((r) => r.code), [0, 0], rs.map((r) => r.out).join('\n'));
  assert.equal(noOverlap(log), 2);
  assert.deepEqual(leftovers(home), []);
});

test('CR-NEW-11: claims of claimants that are gone and older than STALE_MS are swept, fresh or live ones stay', async () => {
  const { withLock } = await import('../src/lock.mjs');
  process.env.KETTE_HOME = tmp();
  const locks = locksOf(process.env.KETTE_HOME);
  const dead = await deadPid();
  const put = (name, content, age) => { const f = path.join(locks, name); fs.writeFileSync(f, content); if (age) aged(f, age); return name; };
  const swept = [put('c.lck.orphan.claim', JSON.stringify({ pid: dead, start: 1, at: 0 }), 121000), put('other.lck.cut.claim', '', 121000)];
  const kept = [
    put('c.lck.fresh.claim', JSON.stringify({ pid: dead, start: 1, at: Date.now() }), 0),
    put('c.lck.live.claim', JSON.stringify({ pid: process.pid, start: Math.round(performance.timeOrigin), at: 0 }), 121000),
  ];
  assert.equal(withLock('c', () => 'ran'), 'ran');
  const left = fs.readdirSync(locks);
  for (const n of swept) assert.ok(!left.includes(n), `${n} swept`);
  for (const n of kept) assert.ok(left.includes(n), `${n} kept`);
});

for (const code of ['ENOTSUP', 'EPERM', 'EXDEV', 'EOPNOTSUPP', 'EISDIR']) {
  test(`CR-NEW-12: with ~/.kette on a drive without hard links (${code}) 4 processes x 50 withLock still count every increment`, { timeout: 120000 }, async () => {
    const { home, counter, script } = setup();
    const noLinks = hook(`no-links-${code}.mjs`, `const link = fs.linkSync;
fs.linkSync = function (from, to) {
  if (String(to).startsWith(process.env.KETTE_HOME)) throw Object.assign(new Error('${code}: no hard links'), { code: '${code}' });
  return link.call(this, from, to);
};`);
    const env = { ...process.env, KETTE_HOME: home };
    const rs = await Promise.all(Array.from({ length: 4 }, () => runNode(noLinks, script, [counter, '50'], env)));
    assert.deepEqual(rs.map((r) => r.code), [0, 0, 0, 0], rs.map((r) => r.out).join('\n'));
    assert.equal(Number(fs.readFileSync(counter, 'utf8')), 200);
    assert.deepEqual(leftovers(home), []);
  });
}

test('CR-NEW-12: a drive with neither hard links nor exclusive files gets a message that names KETTE_HOME', async () => {
  const { home, counter, script } = setup();
  const none = hook('no-files.mjs', `const link = fs.linkSync;
const open = fs.openSync;
const here = (p) => String(p).startsWith(process.env.KETTE_HOME);
fs.linkSync = function (from, to) { if (here(to)) throw Object.assign(new Error('ENOTSUP'), { code: 'ENOTSUP' }); return link.call(this, from, to); };
fs.openSync = function (p, flags, ...rest) { if (here(p) && String(flags).includes('x')) throw Object.assign(new Error('EINVAL'), { code: 'EINVAL' }); return open.call(this, p, flags, ...rest); };`);
  const r = await runNode(none, script, [counter, '1'], { ...process.env, KETTE_HOME: home });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /kette cannot create lock files in .*locks \(EINVAL\).*Set KETTE_HOME to a folder on a local drive/s);
});

test('CR-NEW-13: a lock whose pid now runs another process is taken over without waiting for STALE_MS', { timeout: 120000 }, async () => {
  const { home, counter, script, env } = setup();
  // The pid is alive (this test process), but the owner started an hour before it: the pid was reused
  fs.writeFileSync(path.join(locksOf(home), 'c.lck'), JSON.stringify({ pid: process.pid, start: Math.round(performance.timeOrigin) - 3600000, at: Date.now() - 3000, token: 'reused' }));
  const started = Date.now();
  const r = await run(script, [counter, '1'], env);
  assert.equal(r.code, 0, r.out);
  assert.ok(Date.now() - started < 25000, 'taken over long before the 30 s wait ends');
  assert.equal(Number(fs.readFileSync(counter, 'utf8')), 1);
  assert.deepEqual(leftovers(home), []);
});

test('CR-NEW-13: an empty or unreadable lock is freed once it was not changed for STALE_MS', async () => {
  const { withLock, lockFile } = await import('../src/lock.mjs');
  process.env.KETTE_HOME = tmp();
  for (const [name, content] of [['empty', ''], ['cut', '{"pid":12']]) {
    const f = lockFile(name);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, content);
    aged(f, 121000);
    const started = Date.now();
    assert.equal(withLock(name, () => 'ran'), 'ran');
    assert.ok(Date.now() - started < 5000, `${name}: no wait`);
    assert.equal(fs.existsSync(f), false);
  }
  assert.deepEqual(fs.readdirSync(path.dirname(lockFile('x'))), []);
});
