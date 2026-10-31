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

// Temp file of this process in the same folder, then rename: readers never see half a file
export function writeAtomic(file, content, mode = 0o644) {
  const dest = realTarget(file);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const temp = path.join(path.dirname(dest), `.${path.basename(dest)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(temp, content, { mode, flag: 'wx' });
    fs.renameSync(temp, dest);
  } catch (err) {
    fs.rmSync(temp, { force: true });
    throw err;
  }
}

// Same with mode 600, so a secret is never readable by others
export const writePrivate = (file, content) => writeAtomic(file, content, 0o600);

// target is root or below it; path.relative across Windows drives returns an absolute path, which is never inside
export function isInside(root, target, impl = path) {
  const rel = impl.relative(impl.resolve(root), impl.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !impl.isAbsolute(rel));
}
