import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Real target of a symlinked dotfile (e.g. ~/.npmrc from a dotfiles repo), so the link stays a link
function realTarget(file) {
  try { return fs.realpathSync(file); } catch { return file; }
}

// Temp file with mode 600 in the same folder, then rename: readers never see half a file and the secret is never readable by others
export function writePrivate(file, content) {
  const dest = realTarget(file);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const temp = path.join(path.dirname(dest), `.${path.basename(dest)}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(temp, content, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, dest);
  } catch (err) {
    fs.rmSync(temp, { force: true });
    throw err;
  }
}
