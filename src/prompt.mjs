import fs from 'node:fs';
import tty from 'node:tty';
import readline from 'node:readline/promises';
import { ExitError } from './errors.mjs';
import { dim, inputStyle, num } from './out.mjs';

export const NO_TERMINAL = 'No terminal. Use --yes with --stack/--platform/--patterns.';

let input = null;
let rl = null;

// Keyboard input, even when stdin is redirected; without a terminal (CI, Docker, agents) the command stops with exit code 2
function terminal() {
  if (input) return input;
  if (process.stdin.isTTY) return (input = process.stdin);
  let fd = null;
  try {
    if (process.platform !== 'win32') fd = fs.openSync('/dev/tty', 'r');
  } catch {
    fd = null;
  }
  if (fd === null || !tty.isatty(fd)) {
    if (fd !== null) fs.closeSync(fd);
    throw new ExitError(NO_TERMINAL);
  }
  return (input = new tty.ReadStream(fd));
}

function open() {
  rl ??= readline.createInterface({ input: terminal(), output: process.stdout });
  return rl;
}

export async function ask(question, fallback = '') {
  const [on, off] = inputStyle();
  const answer = (await open().question(`${question}${fallback ? ` ${dim(`[${fallback}]`)}` : ''}: ${on}`)).trim();
  process.stdout.write(off);
  return answer || fallback;
}

// Bracketed paste (iTerm, most terminals) wraps pasted text in ESC[200~ ... ESC[201~; those and other control characters are no part of a secret
export const cleanSecret = (raw) => raw.replace(/\x1b\[[0-9;]*[~A-Za-z]/g, '').replace(/[\x00-\x1f\x7f]/g, '').trim();

// Hidden input for secrets: raw mode, no echo, Enter ends, Ctrl+C cancels; without a terminal noTerminal says how to pass the value instead
export async function askSecret(question, noTerminal = NO_TERMINAL) {
  let keys;
  try { keys = terminal(); } catch (err) {
    if (err instanceof ExitError && err.message === NO_TERMINAL) throw new ExitError(noTerminal);
    throw err;
  }
  rl?.close();
  rl = null;
  process.stdout.write(`${question}: `);
  return new Promise((resolve, reject) => {
    let value = '';
    const done = (err) => {
      keys.off('data', onData);
      keys.setRawMode(false);
      keys.pause();
      process.stdout.write('\n');
      if (err) reject(err); else resolve(cleanSecret(value));
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done();
        if (ch === '\u0003') return done(new ExitError('Cancelled.', 130));
        value = ch === '\u007f' || ch === '\b' ? value.slice(0, -1) : value + ch;
      }
    };
    keys.setRawMode(true);
    keys.setEncoding('utf8');
    keys.on('data', onData);
    keys.resume();
  });
}

export async function confirm(question, yes = false) {
  if (yes) return true;
  const a = (await ask(`${question} ${dim('(y/n)')}`, 'n')).toLowerCase();
  // j and ja still count for people used to the German prompt
  return ['y', 'yes', 'j', 'ja'].includes(a);
}

export async function choose(question, options, fallback) {
  console.log(`\n${question}`);
  options.forEach((o, i) => console.log(`  ${num(`${i + 1})`)} ${o.label}`));
  const a = await ask('Choose (numbers, comma separated)', fallback);
  return a.split(',').map((s) => options[Number(s.trim()) - 1]).filter(Boolean).map((o) => o.value);
}

export function close() {
  rl?.close();
  rl = null;
  if (input && input !== process.stdin) input.destroy();
  input = null;
}
