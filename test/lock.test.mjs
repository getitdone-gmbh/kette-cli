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

const run = (script, args, env) => new Promise((resolve) => {
  const c = spawn(process.execPath, [script, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
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
