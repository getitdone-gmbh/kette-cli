// Checks before kette runner install reads a code or writes a file (docs/adr/0004 point 2, KR-30, KR-36, KR-38, KR-48)
import fs from 'node:fs';
import path from 'node:path';
import { ExitError } from '../errors.mjs';

export const WINDOWS = 'Runners are not supported on Windows in this version. Use macOS or Linux.';
export const SIGN_IN = 'Sign in first: kette login <key>';
export const INSTALL_CLAUDE = 'Install Claude Code first: https://docs.claude.com/en/docs/claude-code/setup';
export const SIGN_IN_CLAUDE = 'Sign in to Claude Code first: run claude once and log in.';
const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

export function checkPlatform(platform) {
  if (platform === 'win32') throw new ExitError(WINDOWS, 2);
  if (platform !== 'linux' && platform !== 'darwin') throw new ExitError(`Runners run on macOS and Linux, not on ${platform}.`, 2);
}

export function checkNode(version, min = 22) {
  const major = Number(String(version).split('.')[0]);
  if (!(major >= min)) throw new ExitError(`The runner needs Node ${min} or newer, this kette runs on Node ${version}. Update Node and run the command again.`, 1);
}

// A file named on PATH, like the shell finds it; null without one
export function findOnPath(name, pathEnv = '') {
  for (const dir of String(pathEnv).split(path.delimiter).filter(Boolean)) {
    const f = path.join(dir, name);
    try {
      if (fs.statSync(f).isFile()) { fs.accessSync(f, fs.constants.X_OK); return f; }
    } catch {
      // not here, try the next folder
    }
  }
  return null;
}

// Installed and signed in, without a billable call and without reading credentials: --version, then auth status when this claude
// knows it, otherwise only whether the credentials exist (Linux file under CLAUDE_CONFIG_DIR like the runner, macOS keychain entry without -w); an own ANTHROPIC_API_KEY counts
export function claudeStatus(io) {
  const bin = findOnPath('claude', io.env.PATH);
  if (!bin || io.exec(bin, ['--version']).status !== 0) return { installed: false, signedIn: false, bin: null };
  if (io.env.ANTHROPIC_API_KEY) return { installed: true, signedIn: true, bin };
  const help = io.exec(bin, ['auth', '--help']);
  if (help.status === 0 && /\bstatus\b/.test(help.stdout || '')) return { installed: true, signedIn: io.exec(bin, ['auth', 'status']).status === 0, bin };
  if (io.platform === 'darwin') return { installed: true, signedIn: io.exec('security', ['find-generic-password', '-s', 'Claude Code-credentials']).status === 0, bin };
  return { installed: true, signedIn: fs.existsSync(path.join(io.env.CLAUDE_CONFIG_DIR || path.join(io.homeDir, '.claude'), '.credentials.json')), bin };
}

export function checkClaude(io) {
  const s = claudeStatus(io);
  if (!s.installed) throw new ExitError(INSTALL_CLAUDE, 1);
  if (!s.signedIn) throw new ExitError(SIGN_IN_CLAUDE, 1);
  return s;
}

// --repo owner/name, repeated or comma separated; asked at a terminal when missing, exit 64 without one (architecture AD-8)
export async function repoList(opts, io) {
  let repos = opts.repos || [];
  if (repos.length === 0 && io.hasTerminal) repos = (await io.ask('Repos the agents may work on (owner/name, comma separated)')).split(/[\s,]+/).filter(Boolean);
  if (repos.length === 0) throw new ExitError('Name the repos the agents may work on: --repo owner/name (repeat it for more).', 64);
  const bad = repos.find((r) => !REPO.test(r));
  if (bad) throw new ExitError(`--repo ${bad} is not owner/name.`, 64);
  return [...new Set(repos)];
}

// Only the path is checked (exists, a file, owned by the user, mode 600); the value is never read (AD-9)
export function checkTokenFile(opts, io) {
  const given = opts['git-token-file'];
  if (!given) {
    if (opts['no-agent-push']) return null;
    throw new ExitError('Pass --git-token-file <path> with a fine-grained GitHub token for the repos (Contents and Pull requests read and write, file mode 600). See docs/runner.md.', 64);
  }
  const file = path.resolve(given.replace(/^~(?=$|\/)/, io.homeDir));
  let st;
  try { st = fs.statSync(file); } catch { throw new ExitError(`--git-token-file ${file} not found.`, 1); }
  if (!st.isFile()) throw new ExitError(`--git-token-file ${file} is not a file.`, 1);
  const me = process.getuid?.();
  if (me !== undefined && st.uid !== me) throw new ExitError(`--git-token-file ${file} belongs to another user.`, 1);
  if ((st.mode & 0o077) !== 0) throw new ExitError(`--git-token-file ${file} is readable by others. Fix with: chmod 600 ${file}`, 1);
  return file;
}

// vault and infisical need addresses and client files, set up by hand in stage 1 (AD-7, KR-41)
export function walletOption(opts) {
  const w = opts.wallet;
  if (!w) return null;
  if (w === 'vault' || w === 'infisical') throw new ExitError(`--wallet ${w} is set up by hand: see vendor/zero-wallet/README.md in ~/.kette/runner/current/zero-agent-runner. kette runner install only sets up --wallet file.`, 64);
  if (w !== 'file') throw new ExitError('Use --wallet file (vault and infisical are set up by hand).', 64);
  return 'file';
}

// The runner checks the sandbox itself (a working bwrap, not only one on PATH) and refuses before the code with its own text;
// kette shows that text and asks, it keeps no copy of it (CR768-09, SEC768-04)
export const RUNNER_ASKS_CONSENT = /--accept-unsandboxed/;
// What the runner says when every check passed and only the code was missing (the dry run gets an empty stdin)
export const RUNNER_WANTS_CODE = /does not look like a registration code|No code read/;

// The text of the runner goes out unchanged
export async function confirmUnsandboxed(text, io) {
  if (!io.hasTerminal) throw new ExitError(`${text}\nPass --accept-unsandboxed to allow it.`, 1);
  io.print(text);
  if (!(await io.confirm('Continue?'))) throw new ExitError('Cancelled, nothing was installed.', 1);
}
