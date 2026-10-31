import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { home } from './paths.mjs';

// Lock for machine files several kette processes change at once (docs/adr/0002, decision 17). Three rules make it correct:
// 1. The lock is a file that appears with its whole owner (pid, time, token): the owner is written to a temp file of this process,
//    then hard-linked to the lock path; link fails when the path exists, so exactly one process wins and nobody sees a half owner.
// 2. Only one process may remove the lock file of a given token: it first links a claim file named after that token (link fails when
//    the claim exists), checks that the claim holds that token, then unlinks the lock. While the claim exists nobody else can remove
//    that lock, and nobody can create a new one while the lock path is taken, so the unlink always removes the lock it checked.
//    The holder releases this way, and a waiter removes a stale lock this way.
// 3. A lock is stale only with a readable owner whose process is gone or which is older than STALE_MS; a missing lock means try again.
const WAIT_MS = 30000;
const STALE_MS = 120000;
// A claimant needs microseconds between its link and its unlink; a claim of a dead lock owner older than this was left by a holder
// that died during its release
const CLAIM_GRACE_MS = 10000;
const BUSY = ['EPERM', 'EBUSY', 'EACCES'];

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
export const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; } };
export const lockFile = (name) => path.join(home(), 'locks', `${name}.lck`);
const claimFile = (file, token) => `${file}.${token}.claim`;
const readOwner = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const isStale = (owner) => Boolean(owner?.token) && (!alive(owner.pid) || Date.now() - owner.at > STALE_MS);

// Windows refuses some operations for a moment while another process has the file open; those are retried, everything else fails
function retry(op, ms = 2000) {
  const until = Date.now() + ms;
  for (;;) {
    try { return op(); } catch (err) {
      if (!BUSY.includes(err.code) || Date.now() > until) throw err;
      pause(5);
    }
  }
}

const linkOrTaken = (from, to) => {
  try { retry(() => fs.linkSync(from, to)); return true; } catch (err) { if (err.code === 'EEXIST') return false; throw err; }
};
const unlinkIfThere = (file) => { try { retry(() => fs.unlinkSync(file)); } catch (err) { if (err.code !== 'ENOENT') throw err; } };

// Rule 2; a claim left by a remover that died is cleared: at once after CLAIM_GRACE_MS when the lock owner it holds is dead
// (the holder died while releasing), otherwise after STALE_MS
export function removeIfToken(file, token) {
  const claim = claimFile(file, token);
  try {
    const age = Date.now() - fs.lstatSync(claim).ctimeMs;
    const owner = readOwner(claim);
    if (age > STALE_MS || (age > CLAIM_GRACE_MS && owner && !alive(owner.pid))) unlinkIfThere(claim);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  // The lock may be gone already (its holder released it, another waiter removed it): then there is nothing to remove
  let claimed;
  try { claimed = linkOrTaken(file, claim); } catch (err) { if (err.code === 'ENOENT') return false; throw err; }
  if (!claimed) return false;
  try {
    if (readOwner(claim)?.token !== token) return false;
    unlinkIfThere(file);
    return true;
  } finally {
    unlinkIfThere(claim);
  }
}

// Runs fn while holding the lock; locks with different names never wait for each other, the same name must not be nested
export function withLock(name, fn) {
  const { file, token } = acquire(name);
  try {
    return fn();
  } finally {
    release(file, token, name);
  }
}

// The same lock around async work (a board write); released when the promise settles
export async function withLockAsync(name, fn) {
  const { file, token } = acquire(name);
  try {
    return await fn();
  } finally {
    release(file, token, name);
  }
}

function acquire(name) {
  const file = lockFile(name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  sweepDead(path.dirname(file), /\.(\d+)\.[0-9a-f]+\.tmp$/);
  const owner = { pid: process.pid, at: Date.now(), token: crypto.randomBytes(8).toString('hex') };
  const temp = `${file}.${process.pid}.${owner.token}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(owner));
  const until = Date.now() + WAIT_MS;
  try {
    while (!linkOrTaken(temp, file)) {
      const current = readOwner(file);
      if (isStale(current)) { removeIfToken(file, current.token); continue; }
      if (Date.now() > until) throw new Error(`Another kette process is changing ${name} (lock ${file}). Try again; if no kette runs, delete that file.`);
      // A short random pause, so waiting processes do not retry in lockstep
      pause(1 + Math.floor(Math.random() * 8));
    }
  } finally {
    unlinkIfThere(temp);
  }
  return { file, token: owner.token };
}

// Never gives up silently: a release that keeps failing (Windows keeps a file busy) says so, the next run takes the lock over
function release(file, token, name) {
  try {
    if (!removeIfToken(file, token) && readOwner(file)?.token === token) throw new Error('lock still held');
  } catch (err) {
    console.error(`kette: lock ${name} not released (${err.code || err.message}); the next kette takes it over once this process has ended.`);
  }
}

// Temp files and folders of kette processes that died before cleaning up (name holds .<pid>.); only of dead processes
export function sweepDead(dir, pattern) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    const m = name.match(pattern);
    if (m && Number(m[1]) !== process.pid && !alive(Number(m[1]))) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  }
}
