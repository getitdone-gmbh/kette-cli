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
function retrying(op, busy = BUSY) {
  const until = Date.now() + 2000;
  for (let wait = 2; ; wait = Math.min(wait * 2, 50)) {
    try { return op(); } catch (err) {
      if (!busy.includes(err.code) || Date.now() > until) throw err;
      pause(wait);
    }
  }
}

// New files get 0o666 and the umask decides, as with a plain write (umask 002 gives 664, 022 gives 644)
const NEW_FILE = 0o666;

// Writes the whole content into an exclusively created file and flushes it; exact: the mode as given, not reduced by the umask
function writeNew(file, content, mode, exact) {
  const fd = fs.openSync(file, 'wx', mode);
  try {
    if (exact && process.platform !== 'win32') fs.fchmodSync(fd, mode);
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// The whole content in a temp file of this process next to the target, flushed to disk before anyone links or renames it
function writeTemp(dest, content, mode, exact) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const temp = path.join(path.dirname(dest), `.${path.basename(dest)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  writeNew(temp, content, mode, exact);
  return temp;
}

// Mode of an existing file, so a renewed file keeps it exactly; null for a new one
const modeOf = (file) => { try { return fs.statSync(file).mode & 0o777; } catch { return null; } };

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
  const keep = mode ?? modeOf(dest);
  const temp = writeTemp(dest, content, keep ?? NEW_FILE, keep !== null);
  try {
    // The rename replaces the inode: owner and hard links of the old file do not carry over; the folder itself is not fsynced
    retrying(() => fs.renameSync(temp, dest));
  } catch (err) {
    fs.rmSync(temp, { force: true });
    throw err;
  }
  sweepTemps(dest);
}

// Devices where hard links do not work (exFAT, FAT, some network and FUSE drives), found once per device and remembered
const noLinks = new Set();
const LINKS_UNSUPPORTED = ['ENOTSUP', 'ENOSYS', 'EXDEV', 'EOPNOTSUPP'];
const deviceOf = (dir) => { try { return fs.statSync(dir).dev; } catch { return null; } };

// EPERM means a busy file on Windows or a drive without hard links; one probe link of a fresh file in the same folder tells them apart
function linksWork(dir) {
  const probe = path.join(dir, `.kette-link-probe.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    writeNew(probe, '', NEW_FILE, false);
    fs.linkSync(probe, `${probe}.link`);
    fs.rmSync(`${probe}.link`, { force: true });
    return true;
  } catch (err) {
    if (LINKS_UNSUPPORTED.includes(err.code) || err.code === 'EPERM') return false;
    throw err;
  } finally {
    fs.rmSync(probe, { force: true });
  }
}

// A new file that must not replace anything (also no dangling symlink): the full temp file is hard-linked to the name, which fails
// with EEXIST when the name is taken, so the file appears whole or not at all. Without hard links (CR-AT-1) it is created with an
// exclusive open, written and flushed: never replacing stays, only a kette killed in the middle can leave it half written there
export function createAtomic(file, content, mode = NEW_FILE) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const dev = deviceOf(dir);
  if (noLinks.has(dev)) { createDirect(file, content, mode); return; }
  const temp = writeTemp(file, content, mode, false);
  try {
    try {
      retrying(() => fs.linkSync(temp, file), ['EBUSY', 'EACCES']);
    } catch (err) {
      if (!LINKS_UNSUPPORTED.includes(err.code) && !(err.code === 'EPERM' && !linksWork(dir))) {
        if (err.code !== 'EPERM') throw err;
        retrying(() => fs.linkSync(temp, file));
      } else {
        noLinks.add(dev);
        createDirect(file, content, mode);
      }
    }
  } finally {
    fs.rmSync(temp, { force: true });
  }
  sweepTemps(file);
}

// The exclusive open fails with EEXIST when the name is taken; a write that fails after it removes only the file it opened
function createDirect(file, content, mode) {
  const fd = fs.openSync(file, 'wx', mode);
  try {
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
  } catch (err) {
    fs.closeSync(fd);
    fs.rmSync(file, { force: true });
    throw err;
  }
  fs.closeSync(fd);
}

// Same with mode 600, so a secret is never readable by others
export const writePrivate = (file, content) => writeAtomic(file, content, 0o600);

// target is root or below it; path.relative across Windows drives returns an absolute path, which is never inside
export function isInside(root, target, impl = path) {
  const rel = impl.relative(impl.resolve(root), impl.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !impl.isAbsolute(rel));
}
