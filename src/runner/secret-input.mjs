// The one-time runner code: hidden prompt at a terminal, one line of stdin otherwise; never an argument of a child, never printed
import fs from 'node:fs';
import { ExitError } from '../errors.mjs';

export const CODE_FORMAT = /^zrc_[A-Za-z0-9]{4,40}_[A-Za-z0-9_-]{20,120}$/;
export const HISTORY_WARNING = 'The code may stay in your shell history. Next time leave out --code and paste it at the prompt.';

// First line of stdin; a pipe or a file, read once
export function readStdinLine() {
  return fs.readFileSync(0, 'utf8').split(/\r?\n/)[0];
}

export async function readCode(opts, io) {
  let code;
  if (opts.code) {
    io.printError(`WARN ${HISTORY_WARNING}`);
    code = opts.code;
  } else if (opts['code-stdin'] || !io.stdinIsTty) {
    code = await io.readStdinLine();
  } else {
    code = await io.askSecret('Runner code from workload.zero (Settings, Agents, Connect runner; input hidden)', 'No terminal. Pipe the code on stdin with --code-stdin.');
  }
  code = String(code || '').trim();
  if (!CODE_FORMAT.test(code)) throw new ExitError('That does not look like a runner code (zrc_...). Create a new one in workload.zero under Settings, Agents, Connect runner.', 1);
  return code;
}
