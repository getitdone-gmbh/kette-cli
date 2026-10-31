import fs from 'node:fs';
import path from 'node:path';
import { home } from './paths.mjs';

// Machine files several kette processes may change at once (state.json, instance.json, marketplace folders, bundles) are changed
// under a lock: a folder created atomically with mkdir, holding the owner PID; a lock of a dead process or older than STALE_MS is taken over
const WAIT_MS = 30000;
const STALE_MS = 120000;
const STEP_MS = 20;
const OWNER = 'owner.json';

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; } };
export const lockDir = (name) => path.join(home(), 'locks', `${name}.lock`);

function isStale(dir) {
  try {
    const owner = JSON.parse(fs.readFileSync(path.join(dir, OWNER), 'utf8'));
    return !alive(owner.pid) || Date.now() - owner.at > STALE_MS;
  } catch {
    // Owner not written yet or already gone: only age decides
    try { return Date.now() - fs.statSync(dir).mtimeMs > STALE_MS; } catch { return false; }
  }
}

// Runs fn while holding the lock; locks with different names never wait for each other, the same name must not be nested
export function withLock(name, fn) {
  const dir = lockDir(name);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const until = Date.now() + WAIT_MS;
  for (;;) {
    try {
      fs.mkdirSync(dir);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (isStale(dir)) {
        // Renaming first means only one process takes over a stale lock; when the rename fails another process was faster, so try again
        const aside = `${dir}.stale.${process.pid}`;
        try { fs.renameSync(dir, aside); } catch { continue; }
        fs.rmSync(aside, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > until) throw new Error(`Another kette process is changing ${name} (lock ${dir}). Try again; if no kette runs, delete that folder.`);
      pause(STEP_MS);
    }
  }
  try {
    fs.writeFileSync(path.join(dir, OWNER), JSON.stringify({ pid: process.pid, at: Date.now() }));
    return fn();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
