import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { home } from './paths.mjs';
import { linksKnownMissing, linksMissing } from './files.mjs';

// Lock for machine files several kette processes change at once (docs/adr/0002, decisions 17 and 21). Three rules make it correct:
// 1. The lock is a file that appears with its whole owner (pid, start, time, token): the owner is written to a temp file of this
//    process, then hard-linked to the lock path; link fails when the path exists, so exactly one process wins and nobody sees a half
//    owner. On a drive without hard links the lock is created exclusively and written at once; a reader may see it empty for a moment.
// 2. Only one process may remove the lock file of a given token: it first places its own claim file named after that token (fails when
//    the claim exists), checks that the lock still holds that token, then unlinks the lock. While the claim exists nobody else can
//    remove that lock, and nobody can create a new one while the lock path is taken, so the unlink always removes the lock it checked.
//    A claim names its claimant (pid, start, time) and is cleared only once that claimant is gone, so a claimant that was paused for
//    a long time never loses its claim. The holder releases this way, and a waiter removes a stale lock this way.
// 3. A lock is stale only with a readable owner whose process is gone (dead, or its pid now runs another process) or which is older
//    than STALE_MS; a missing lock means try again, an unreadable one is removed only when it was not changed for STALE_MS.
const WAIT_MS = 30000;
const STALE_MS = 120000;
// A live process holds a lock or claim for milliseconds; only one held longer is worth asking the system whether its pid was reused
const REUSE_CHECK_MS = 2000;
// Start times from the system are exact to a second
const START_SLACK_MS = 2000;
const BUSY = ['EPERM', 'EBUSY', 'EACCES'];
const START = Math.round(performance.timeOrigin);

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const hex = () => crypto.randomBytes(6).toString('hex');
export const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; } };
export const lockFile = (name) => path.join(home(), 'locks', `${name}.lck`);
const claimFile = (file, token) => `${file}.${token}.claim`;
const readOwner = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const readRaw = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };
// Windows answers EPERM for a file whose delete is pending: it is as good as gone
const statOf = (file) => { try { return fs.statSync(file); } catch (err) { if (err.code === 'ENOENT' || err.code === 'EPERM') return null; throw err; } };

// Start of a running process in ms since the epoch, null when the system does not tell; asked again after a few seconds at most
const starts = new Map();
function startOf(pid) {
  if (pid === process.pid) return START;
  const known = starts.get(pid);
  if (known && Date.now() - known.at < 5000) return known.start;
  const start = systemStart(pid);
  starts.set(pid, { start, at: Date.now() });
  return start;
}

function systemStart(pid) {
  try {
    if (process.platform === 'linux') {
      // Field 22 of /proc/<pid>/stat counts clock ticks (USER_HZ, 100 on Linux) since boot; the name in field 2 may hold spaces
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const ticks = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
      const boot = Number(fs.readFileSync('/proc/stat', 'utf8').match(/^btime (\d+)$/m)[1]);
      return boot * 1000 + ticks * 10;
    }
    const [cmd, args] = process.platform === 'win32'
      ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToString('o')`]]
      : ['ps', ['-o', 'lstart=', '-p', String(pid)]];
    const out = spawnSync(cmd, args, { encoding: 'utf8', timeout: 10000, windowsHide: true, env: { ...process.env, LC_ALL: 'C' } }).stdout?.trim();
    const start = Date.parse(out);
    return Number.isFinite(start) ? start : null;
  } catch {
    return null;
  }
}

// The process that wrote an owner or claim is gone: dead, or after heldMs its pid belongs to a process that started at another time
function gone({ pid, start }, heldMs) {
  if (!alive(pid)) return true;
  if (!start || heldMs <= REUSE_CHECK_MS) return false;
  const actual = startOf(pid);
  return actual !== null && Math.abs(actual - start) > START_SLACK_MS;
}
const isStale = (owner) => Boolean(owner?.token) && (Date.now() - owner.at > STALE_MS || gone(owner, Date.now() - owner.at));

// Windows refuses some operations for a moment while another process has the file open; those are retried, everything else fails
function retry(op, busy = BUSY, ms = 2000) {
  const until = Date.now() + ms;
  for (;;) {
    try { return op(); } catch (err) {
      if (!busy.includes(err.code) || Date.now() > until) throw err;
      pause(5);
    }
  }
}

const unlinkIfThere = (file) => { try { retry(() => fs.unlinkSync(file)); } catch (err) { if (err.code !== 'ENOENT') throw err; } };

// Exclusive create for a drive without hard links; a write that fails removes only the file this process created (CR-NEW-12)
function createOrTaken(file, content) {
  let fd;
  try {
    fd = retry(() => fs.openSync(file, 'wx'));
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw new Error(`kette cannot create lock files in ${path.dirname(file)} (${err.code}): this drive allows neither hard links nor exclusive files. Set KETTE_HOME to a folder on a local drive.`);
  }
  try {
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
  } catch (err) {
    fs.closeSync(fd);
    unlinkIfThere(file);
    throw err;
  }
  fs.closeSync(fd);
  return true;
}

// Puts content at file only if the name is free: true when this process placed it, false when it was taken
function place(file, content) {
  if (linksKnownMissing(file)) return createOrTaken(file, content);
  const temp = `${file}.${process.pid}.${hex()}.tmp`;
  fs.writeFileSync(temp, content);
  try {
    try {
      retry(() => fs.linkSync(temp, file), ['EBUSY', 'EACCES']);
      return true;
    } catch (err) {
      if (err.code === 'EEXIST') return false;
      if (linksMissing(err, file)) return createOrTaken(file, content);
      if (err.code !== 'EPERM') throw err;
      try { retry(() => fs.linkSync(temp, file)); return true; } catch (again) { if (again.code === 'EEXIST') return false; throw again; }
    }
  } finally {
    unlinkIfThere(temp);
  }
}

const claimant = () => JSON.stringify({ pid: process.pid, start: START, at: Date.now() });

// A claim whose claimant is gone is cleared; an unreadable one (cut short on a drive without hard links) only after STALE_MS.
// minAge keeps the sweep away from fresh claims. The claim is moved aside first, so of several processes only one clears it, and a
// claim that a live claimant placed after the look goes back; the content tells them apart (pid, start and time in ms), not the
// file times, which Windows reports differently for the names of one hard-linked file
function clearClaim(claim, minAge = 0) {
  const before = statOf(claim);
  if (!before) return;
  const raw = readRaw(claim);
  const by = readOwner(claim);
  // The time a claimant wrote counts; the file time only for a claim cut short
  const age = Date.now() - (Number.isFinite(by?.at) ? by.at : before.mtimeMs);
  if (age < minAge || !(by?.pid ? gone(by, age) : age > STALE_MS)) return;
  const aside = `${claim}.${process.pid}.${hex()}.tmp`;
  try { retry(() => fs.renameSync(claim, aside)); } catch (err) { if (err.code === 'ENOENT') return; throw err; }
  try {
    const moved = readRaw(aside);
    if (moved !== raw) place(claim, moved ?? '');
  } finally {
    unlinkIfThere(aside);
  }
}

// Rule 2: removes file under the claim name once matches() confirms it is still the lock that was judged
function removeClaimed(file, name, matches) {
  const claim = claimFile(file, name);
  clearClaim(claim);
  if (!place(claim, claimant())) return false;
  try {
    if (!matches()) return false;
    unlinkIfThere(file);
    return true;
  } finally {
    unlinkIfThere(claim);
  }
}

export const removeIfToken = (file, token) => removeClaimed(file, token, () => readOwner(file)?.token === token);

// A lock without a readable owner that nobody changed for STALE_MS was left by a kette that died while creating it (CR-NEW-13)
function removeAbandoned(file) {
  const seen = statOf(file);
  const abandoned = (s) => s && readOwner(file) === null && Date.now() - s.mtimeMs > STALE_MS;
  if (!abandoned(seen)) return false;
  return removeClaimed(file, 'unreadable', () => { const now = statOf(file); return abandoned(now) && now.mtimeMs === seen.mtimeMs && now.size === seen.size; });
}

// Claims of claimants that are gone, left next to any lock (CR-NEW-11)
function sweepClaims(dir) {
  for (const name of fs.readdirSync(dir)) if (name.endsWith('.claim')) clearClaim(path.join(dir, name), STALE_MS);
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
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  sweepDead(dir, /\.(\d+)\.[0-9a-f]+\.tmp$/);
  sweepClaims(dir);
  const owner = { pid: process.pid, start: START, at: Date.now(), token: crypto.randomBytes(8).toString('hex') };
  const until = Date.now() + WAIT_MS;
  // A taken lock is judged without writing a temp file in every round
  while (fs.existsSync(file) || !place(file, JSON.stringify(owner))) {
    if (Date.now() > until) throw new Error(`Another kette process is changing ${name} (lock ${file}). Try again; if no kette runs, delete that file.`);
    const current = readOwner(file);
    // Gone meanwhile: try again at once; stale or abandoned: retry once it is removed, otherwise wait a moment
    if (isStale(current) ? removeIfToken(file, current.token) : !current && (!statOf(file) || removeAbandoned(file))) continue;
    // A short random pause, so waiting processes do not retry in lockstep
    pause(1 + Math.floor(Math.random() * 8));
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
