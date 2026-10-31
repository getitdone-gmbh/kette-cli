import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Real target of a symlinked dotfile (e.g. ~/.npmrc from a dotfiles repo), so the link stays a link
function realTarget(file) {
  try { return fs.realpathSync(file); } catch { return file; }
}

// Group or others may read the file (POSIX only, Windows has no mode bits)
export const othersCanRead = (file) => process.platform !== 'win32' && fs.existsSync(file) && (fs.statSync(file).mode & 0o077) !== 0;
export const privateHint = (file, cmd) => `${file} is readable by others. Fix with: ${cmd(`chmod 600 ${file}`)}`;

const BUSY = ['EPERM', 'EBUSY', 'EACCES'];
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Windows refuses a rename or link over a file another process has open for a moment (CR-NEW-9); retried for up to 2 seconds
function retrying(op) {
  const until = Date.now() + 2000;
  for (let wait = 2; ; wait = Math.min(wait * 2, 50)) {
    try { return op(); } catch (err) {
      if (!BUSY.includes(err.code) || Date.now() > until) throw err;
      pause(wait);
    }
  }
}

// The whole content in a temp file of this process next to the target, flushed to disk before anyone links or renames it
function writeTemp(dest, content, mode) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const temp = path.join(path.dirname(dest), `.${path.basename(dest)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  const fd = fs.openSync(temp, 'wx', mode);
  try {
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return temp;
}

// Mode of an existing file, so a renewed file keeps it; mode for a new one otherwise
const modeOf = (file, fallback) => { try { return fs.statSync(file).mode & 0o777; } catch { return fallback; } };

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; } };

// Temp files of this name that a killed kette left next to it, only those of processes that are gone
function sweepTemps(dest) {
  const prefix = `.${path.basename(dest)}.`;
  let names;
  try { names = fs.readdirSync(path.dirname(dest)); } catch { return; }
  for (const n of names) {
    const m = n.startsWith(prefix) && n.slice(prefix.length).match(/^(\d+)\.[0-9a-f]+\.tmp$/);
    if (m && Number(m[1]) !== process.pid && !alive(Number(m[1]))) fs.rmSync(path.join(path.dirname(dest), n), { force: true });
  }
}

// Temp file, then rename: a reader or a kette killed half way never leaves half a file (a profile.json killed after the truncate was empty)
export function writeAtomic(file, content, mode) {
  const dest = realTarget(file);
  const temp = writeTemp(dest, content, mode ?? modeOf(dest, 0o644));
  try {
    retrying(() => fs.renameSync(temp, dest));
  } catch (err) {
    fs.rmSync(temp, { force: true });
    throw err;
  }
  sweepTemps(dest);
}

// A new file that must not replace anything (also no dangling symlink): the full temp file is hard-linked to the name, which fails
// with EEXIST when the name is taken, so the file appears whole or not at all
export function createAtomic(file, content, mode = 0o644) {
  const temp = writeTemp(file, content, mode);
  try {
    retrying(() => fs.linkSync(temp, file));
  } finally {
    fs.rmSync(temp, { force: true });
  }
  sweepTemps(file);
}

// Same with mode 600, so a secret is never readable by others
export const writePrivate = (file, content) => writeAtomic(file, content, 0o600);

// target is root or below it; path.relative across Windows drives returns an absolute path, which is never inside
export function isInside(root, target, impl = path) {
  const rel = impl.relative(impl.resolve(root), impl.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !impl.isAbsolute(rel));
}
