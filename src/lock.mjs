import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { home } from './paths.mjs';
import { linksKnownMissing, linksMissing } from './files.mjs';

// Lock for machine files several kette processes change at once (docs/adr/0002, decisions 17, 21, 22 and 23). Three rules make it correct:
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
// An async holder renews the time of its lock this often, so a long board write is never judged older than STALE_MS (LK-6)
const REFRESH_MS = 10000;
// Windows: the stamped start of Node and the StartTime of the process differ by the start up of Node, which a cold start with a
// virus scan can stretch to many seconds; a reused pid is still caught by STALE_MS
const WINDOWS_SLACK_MS = 30000;
const BUSY = ['EPERM', 'EBUSY', 'EACCES'];

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const hex = () => crypto.randomBytes(6).toString('hex');
export const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; } };
export const lockFile = (name) => path.join(home(), 'locks', `${name}.lck`);
const claimFile = (file, token) => `${file}.${token}.claim`;
const readOwner = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const readRaw = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };
// Windows answers EPERM for a file whose delete is pending: it is as good as gone
const statOf = (file) => { try { return fs.statSync(file); } catch (err) { if (err.code === 'ENOENT' || err.code === 'EPERM') return null; throw err; } };

// What the system says about the start of a process, as it says it and never turned into a clock time, so a clock jump or a time
// zone changes nothing (LK-1, LK-2): Linux the start ticks of /proc/<pid>/stat with the boot id, macOS the lstart text in UTC.
// Windows has no cheap call for the own process, so there the owner keeps the start Node stamped and the StartTime of the system
// is read as UTC; both are stamped once at the start, a later clock jump moves neither. null when the system does not tell
function systemStart(pid) {
  try {
    if (process.platform === 'linux') {
      // Field 22, after the name in field 2, which may hold spaces
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const ticks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
      // Some containers have no boot id: then the ticks alone (LK-7)
      let boot = '';
      try { boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); } catch (err) { if (err.code !== 'ENOENT' && err.code !== 'EACCES') throw err; }
      return boot ? `${boot}:${ticks}` : ticks;
    }
    const windows = process.platform === 'win32';
    const [cmd, args] = windows
      ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).StartTime.ToFileTimeUtc()`]]
      : ['ps', ['-o', 'lstart=', '-p', String(pid)]];
    const out = spawnSync(cmd, args, { encoding: 'utf8', timeout: 10000, windowsHide: true, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } }).stdout?.trim();
    if (!out) return null;
    // FILETIME counts 100 ns since 1601
    return windows ? Number(BigInt(out) / 10000n - 11644473600000n) : out;
  } catch {
    return null;
  }
}

// The own start in the same form, asked once per process
let own;
function ownStart() {
  if (own === undefined) own = process.platform === 'win32' ? Math.round(performance.timeOrigin) : systemStart(process.pid);
  return own;
}

// Start of a running process, asked again after a few seconds at most
const starts = new Map();
function startOf(pid) {
  if (pid === process.pid) return ownStart();
  const known = starts.get(pid);
  if (known && Date.now() - known.at < 5000) return known.start;
  const start = systemStart(pid);
  starts.set(pid, { start, at: Date.now() });
  return start;
}

// Same process: the same text, on Windows the same moment; a start of another form or none tells nothing
function sameStart(recorded, actual) {
  if (typeof recorded === 'number' && typeof actual === 'number') return Math.abs(recorded - actual) <= WINDOWS_SLACK_MS;
  return typeof recorded !== typeof actual || recorded === actual;
}

// The process that wrote an owner or claim is gone: dead, or after heldMs its pid belongs to a process that started at another time
function gone({ pid, start }, heldMs) {
  if (!alive(pid)) return true;
  if (start == null || heldMs <= REUSE_CHECK_MS) return false;
  const actual = startOf(pid);
  return actual !== null && !sameStart(start, actual);
}
// A lock counts from the later of the time in it and its file time, which an async holder renews (LK-6)
const heldFor = (file, owner) => Date.now() - Math.max(owner.at, statOf(file)?.mtimeMs ?? 0);
const isStale = (file, owner) => Boolean(owner?.token) && (heldFor(file, owner) > STALE_MS || gone(owner, heldFor(file, owner)));

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
  let ours;
  try {
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
    // The name must still lead to the file this process wrote; otherwise it was removed and taken meanwhile (LK-4). Some drives
    // without hard links give no stable inode: then the content decides, which holds the own token or claimant (LK-8)
    const written = fs.fstatSync(fd);
    const named = statOf(file);
    ours = Boolean(named) && ((named.ino === written.ino && named.dev === written.dev) || readRaw(file) === content);
  } catch (err) {
    fs.closeSync(fd);
    unlinkIfThere(file);
    throw err;
  }
  fs.closeSync(fd);
  return ours;
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

const claimant = () => JSON.stringify({ pid: process.pid, start: ownStart(), at: Date.now() });

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
  // A claim of this process is a leftover of its own earlier attempt: every lock step runs synchronously, so none of its claims is in
  // use while it looks. A clearer that put back a claim this process had already given up leaves exactly that (KETTE-43)
  const own = by?.pid === process.pid;
  if (!own && (age < minAge || !(by?.pid ? gone(by, age) : age > STALE_MS))) return;
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
// Before the unlink the claimant reads its claim once more: a clearer that could not put back a claim it moved by mistake leaves
// another content there, and then this claimant has lost it (LK-3)
function removeClaimed(file, name, matches) {
  const claim = claimFile(file, name);
  clearClaim(claim);
  const mine = claimant();
  if (!place(claim, mine)) return false;
  const held = () => readRaw(claim) === mine;
  try {
    if (!matches() || !held()) return false;
    unlinkIfThere(file);
    return true;
  } finally {
    if (held()) unlinkIfThere(claim);
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

// A claim only means something while its lock still holds the token it names (an unreadable lock for 'unreadable'): once the lock
// is gone or carries another token, nobody can use the claim any more and a claimant that is still at work stops at its own check
// of the claim (K16-03)
function orphaned(dir, name) {
  const m = name.match(/^(.+\.lck)\.([^.]+)\.claim$/);
  if (!m) return false;
  const lock = path.join(dir, m[1]);
  if (!statOf(lock)) return true;
  const owner = readOwner(lock);
  return m[2] === 'unreadable' ? owner !== null : owner?.token !== m[2];
}

// Claims a killed kette left next to any lock: orphaned ones at once, those of claimants that are gone after STALE_MS (CR-NEW-11)
function sweepClaims(dir) {
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.claim')) continue;
    if (orphaned(dir, name)) unlinkIfThere(path.join(dir, name));
    else clearClaim(path.join(dir, name), STALE_MS);
  }
}

// The last holder of the lock name died while holding it: a kette killed in the middle, whose work may be half done (K16-02)
export function interrupted(name) {
  const owner = readOwner(lockFile(name));
  return Boolean(owner?.token) && gone(owner, Infinity);
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

// The same lock around async work (a board write); released when the promise settles. While the work runs, the file time of the
// lock is renewed, so a board write that takes longer than STALE_MS is never taken over (LK-6)
export async function withLockAsync(name, fn) {
  const { file, token } = acquire(name);
  // A renewal that fails (a busy file on Windows) is tried again in the next round
  const renew = setInterval(() => {
    try { if (readOwner(file)?.token === token) { const now = new Date(); fs.utimesSync(file, now, now); } } catch { return; }
  }, REFRESH_MS);
  renew.unref();
  try {
    return await fn();
  } finally {
    clearInterval(renew);
    release(file, token, name);
  }
}

function acquire(name) {
  const file = lockFile(name);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  sweepDead(dir, /\.(\d+)\.[0-9a-f]+\.tmp$/);
  sweepClaims(dir);
  const owner = { pid: process.pid, start: ownStart(), at: Date.now(), token: crypto.randomBytes(8).toString('hex') };
  const until = Date.now() + WAIT_MS;
  // A taken lock is judged without writing a temp file in every round
  while (fs.existsSync(file) || !place(file, JSON.stringify(owner))) {
    if (Date.now() > until) throw new Error(`Another kette process is changing ${name} (lock ${file}). Try again; if no kette runs, delete that file.`);
    const current = readOwner(file);
    // Stale or abandoned: retry once it is removed
    if (isStale(file, current) ? removeIfToken(file, current.token) : !current && removeAbandoned(file)) continue;
    // A short random pause, so waiting processes do not retry in lockstep; a lock gone meanwhile is tried again after a millisecond,
    // never at once, since on Windows a pending delete looks gone for a while and the loop would spin (LK-5)
    pause(current || statOf(file) ? 1 + Math.floor(Math.random() * 8) : 1);
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
