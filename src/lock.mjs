import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { home } from './paths.mjs';

// Machine files several kette processes may change at once (state.json, instance.json, marketplace folders, bundles) are changed
// under a lock: a folder that appears atomically together with its owner (PID, time, token); a lock without a readable owner,
// of a dead process or older than STALE_MS is taken over
const WAIT_MS = 30000;
const STALE_MS = 120000;
const STEP_MS = 20;
const OWNER = 'owner.json';

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
export const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; } };
export const lockDir = (name) => path.join(home(), 'locks', `${name}.lock`);
const readOwner = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, OWNER), 'utf8')); } catch { return null; } };
const isStale = (owner) => !owner || !alive(owner.pid) || Date.now() - owner.at > STALE_MS;
const taken = (err) => ['EEXIST', 'ENOTEMPTY', 'EPERM', 'EBUSY'].includes(err.code);

// The owner is written into a folder of this process first, then that folder is renamed into place: there is never a lock without owner
function tryCreate(dir, owner) {
  const temp = `${dir}.${process.pid}.${owner.token}.new`;
  fs.mkdirSync(temp, { recursive: true });
  fs.writeFileSync(path.join(temp, OWNER), JSON.stringify(owner));
  try {
    fs.renameSync(temp, dir);
    return true;
  } catch (err) {
    fs.rmSync(temp, { recursive: true, force: true });
    if (taken(err)) return false;
    throw err;
  }
}

// Takes a stale lock over only when it is still the lock that was found stale: renamed aside, its token is compared;
// a lock another process created in between is put back
export function takeOver(dir, stale) {
  const aside = `${dir}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.stale`;
  try { fs.renameSync(dir, aside); } catch { return; }
  if (readOwner(aside)?.token === stale?.token) { fs.rmSync(aside, { recursive: true, force: true }); return; }
  try { fs.renameSync(aside, dir); } catch { fs.rmSync(aside, { recursive: true, force: true }); }
}

// Renamed aside first, then deleted: removing in place would leave an empty folder for a moment, and on POSIX a waiting process
// could rename its new lock onto that empty folder and lose it to this delete
function release(dir, token) {
  if (readOwner(dir)?.token !== token) return;
  const aside = `${dir}.${process.pid}.${token}.stale`;
  try { fs.renameSync(dir, aside); } catch { return; }
  fs.rmSync(aside, { recursive: true, force: true });
}

// Runs fn while holding the lock; locks with different names never wait for each other, the same name must not be nested
export function withLock(name, fn) {
  const dir = lockDir(name);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const owner = { pid: process.pid, at: Date.now(), token: crypto.randomBytes(8).toString('hex') };
  sweepDead(path.dirname(dir), /\.(\d+)\.[0-9a-f]+\.(new|stale)$/);
  const until = Date.now() + WAIT_MS;
  while (!tryCreate(dir, { ...owner, at: Date.now() })) {
    const current = readOwner(dir);
    if (isStale(current)) { takeOver(dir, current); continue; }
    if (Date.now() > until) throw new Error(`Another kette process is changing ${name} (lock ${dir}). Try again; if no kette runs, delete that folder.`);
    pause(STEP_MS);
  }
  try {
    return fn();
  } finally {
    release(dir, owner.token);
  }
}

// Temp folders and files of kette processes that died before cleaning up (name holds .<pid>.); only of dead processes
export function sweepDead(dir, pattern) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    const m = name.match(pattern);
    if (m && Number(m[1]) !== process.pid && !alive(Number(m[1]))) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  }
}
