import fs from 'node:fs';
import tty from 'node:tty';
import readline from 'node:readline/promises';
import { ExitError } from './errors.mjs';

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
  const answer = (await open().question(`${question}${fallback ? ` [${fallback}]` : ''}: `)).trim();
  return answer || fallback;
}

// Hidden input for secrets: raw mode, no echo, Enter ends, Ctrl+C cancels
export async function askSecret(question) {
  const keys = terminal();
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
      if (err) reject(err); else resolve(value.trim());
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
  const a = (await ask(`${question} (y/n)`, 'n')).toLowerCase();
  // j and ja still count for people used to the German prompt
  return ['y', 'yes', 'j', 'ja'].includes(a);
}

export async function choose(question, options, fallback) {
  console.log(`\n${question}`);
  options.forEach((o, i) => console.log(`  ${i + 1}) ${o.label}`));
  const a = await ask('Choose (numbers, comma separated)', fallback);
  return a.split(',').map((s) => options[Number(s.trim()) - 1]).filter(Boolean).map((o) => o.value);
}

export function close() {
  rl?.close();
  rl = null;
  if (input && input !== process.stdin) input.destroy();
  input = null;
}
