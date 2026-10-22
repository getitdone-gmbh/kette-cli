import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmp } from './helpers.mjs';
import { backgroundTheme, bold, brandLine, colorLevel, configure, dim, error, hint, status, symbols } from '../src/out.mjs';

const ESC = '\x1b[';
const tty = { isTTY: true };
afterEach(() => configure({}, {}));

test('color depth: NO_COLOR, FORCE_COLOR, pipes, CI, TERM=dumb and --ci', () => {
  assert.equal(colorLevel({ NO_COLOR: '1', COLORTERM: 'truecolor' }, tty), 0);
  assert.equal(colorLevel({ NO_COLOR: '', TERM: 'xterm' }, tty), 1, 'empty NO_COLOR does not count');
  for (const [value, level] of [['0', 0], ['1', 1], ['2', 2], ['3', 3], ['', 1], ['true', 1], ['false', 0]]) {
    assert.equal(colorLevel({ FORCE_COLOR: value }, { isTTY: false }), level, `FORCE_COLOR=${value}`);
  }
  assert.equal(colorLevel({ NO_COLOR: '1', FORCE_COLOR: '3' }, tty), 0, 'NO_COLOR wins over FORCE_COLOR');
  assert.equal(colorLevel({ COLORTERM: 'truecolor' }, { isTTY: false }), 0, 'pipe');
  assert.equal(colorLevel({ CI: 'true', COLORTERM: 'truecolor' }, tty), 0);
  assert.equal(colorLevel({ TERM: 'dumb' }, tty), 0);
  assert.equal(colorLevel({ COLORTERM: 'truecolor' }, { ...tty, ci: true }), 0);
});

test('color depth in a terminal: truecolor, 256, otherwise 16; --color and --no-color win', () => {
  for (const env of [{ COLORTERM: 'truecolor' }, { COLORTERM: '24bit' }, { WT_SESSION: 'x' }, { TERM_PROGRAM: 'iTerm.app' }, { TERM_PROGRAM: 'vscode' }]) {
    assert.equal(colorLevel(env, tty), 3, JSON.stringify(env));
  }
  assert.equal(colorLevel({ TERM: 'xterm-256color' }, tty), 2);
  assert.equal(colorLevel({ TERM: 'xterm' }, tty), 1);
  assert.equal(colorLevel({ NO_COLOR: '1', CI: '1' }, { isTTY: false, flag: true }), 1);
  assert.equal(colorLevel({ FORCE_COLOR: '3' }, { ...tty, flag: false }), 0);
});

test('background: KETTE_THEME first, then COLORFGBG, otherwise unknown', () => {
  assert.equal(backgroundTheme({ KETTE_THEME: 'light', COLORFGBG: '15;0' }), 'light');
  assert.equal(backgroundTheme({ COLORFGBG: '15;0' }), 'dark');
  assert.equal(backgroundTheme({ COLORFGBG: '0;15' }), 'light');
  assert.equal(backgroundTheme({ COLORFGBG: '0;default;7' }), 'light');
  assert.equal(backgroundTheme({ COLORFGBG: '15;default' }), null);
  assert.equal(backgroundTheme({ KETTE_THEME: 'blue' }), null);
  assert.equal(backgroundTheme({}), null);
});

test('palettes: dark and light in truecolor and 256, 16 theme colors without a known background', () => {
  configure({}, { FORCE_COLOR: '3', KETTE_THEME: 'dark' });
  assert.equal(status('ok', 'OK  '), `${ESC}1m${ESC}38;2;79;240;198mOK  ${ESC}39m${ESC}22m`);
  assert.equal(hint('x'), `${ESC}38;2;255;154;85mx${ESC}39m`);
  assert.equal(error('x'), `${ESC}38;2;255;107;107mx${ESC}39m`);
  assert.equal(dim('x'), `${ESC}38;2;135;148;160mx${ESC}39m`);
  configure({}, { FORCE_COLOR: '2', KETTE_THEME: 'light' });
  assert.equal(status('warn', 'WARN'), `${ESC}1m${ESC}38;5;130mWARN${ESC}39m${ESC}22m`);
  assert.equal(dim('x'), `${ESC}38;5;243mx${ESC}39m`);
  configure({}, { FORCE_COLOR: '3' });
  assert.equal(status('ok', 'OK'), `${ESC}1m${ESC}32mOK${ESC}39m${ESC}22m`);
  assert.equal(hint('x'), `${ESC}1mx${ESC}22m`, 'hint is bold default text in 16 colors');
  assert.equal(error('x'), `${ESC}1;31mx${ESC}22;39m`);
  assert.equal(dim('x'), `${ESC}2mx${ESC}22m`);
  configure({}, { FORCE_COLOR: '1', KETTE_THEME: 'dark' });
  assert.equal(dim('x'), `${ESC}2mx${ESC}22m`, '16 colors even with a known background');
});

test('no color: plain text, never a background color', () => {
  configure({}, { NO_COLOR: '1', FORCE_COLOR: '3' });
  assert.equal(status('fail', 'FAIL') + bold('a') + dim('b'), 'FAILab');
  assert.equal(brandLine('kette 1.0.0'), `${symbols().dot} DIE KETTE  kette 1.0.0`);
  for (const env of [{ FORCE_COLOR: '3', KETTE_THEME: 'dark' }, { FORCE_COLOR: '2', KETTE_THEME: 'light' }, { FORCE_COLOR: '1' }]) {
    configure({}, env);
    assert.doesNotMatch([status('ok', 'OK'), status('fail', 'F'), status('warn', 'W'), status('info', 'I'), brandLine('v')].join(''), /\x1b\[(4\d|10\d|48;)/);
  }
});

// The real binary, the way a terminal or a pipe sees it
function kette(args, env) {
  const bin = fileURLToPath(new URL('../bin/kette.mjs', import.meta.url));
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !['NO_COLOR', 'FORCE_COLOR', 'KETTE_THEME', 'COLORFGBG', 'CI'].includes(k)));
  return spawnSync(process.execPath, [bin, ...args], { env: { ...clean, KETTE_HOME: tmp(), ...env }, encoding: 'utf8' });
}

test('kette help: brand line in mint with FORCE_COLOR=3 and KETTE_THEME=dark, plain in a pipe, with NO_COLOR and --no-color', () => {
  const colored = kette(['help'], { FORCE_COLOR: '3', KETTE_THEME: 'dark' }).stdout;
  assert.ok(colored.startsWith(`${ESC}1m${ESC}38;2;79;240;198m`), JSON.stringify(colored.slice(0, 40)));
  assert.match(colored, /DIE KETTE/);
  assert.ok(colored.includes(`${ESC}38;2;79;240;198mkette init [folder]${ESC}39m   Create`), 'commands in the accent color, padding plain');
  for (const env of [{}, { NO_COLOR: '1', FORCE_COLOR: '3' }]) assert.doesNotMatch(kette(['help'], env).stdout, /\x1b/);
  assert.doesNotMatch(kette(['help', '--no-color'], { FORCE_COLOR: '3' }).stdout, /\x1b/);
  assert.match(kette(['help', '--color'], {}).stdout, /\x1b\[1m\x1b\[32m/);
});

test('stdout and stderr decide separately: a terminal on stdout, a file on stderr stays plain', async () => {
  configure({}, { TERM: 'xterm-256color' }, { out: true, err: false });
  const { toStderr } = await import('../src/out.mjs');
  assert.match(status('warn', 'WARN'), /\x1b\[/);
  assert.equal(toStderr.status('warn', 'WARN') + toStderr.cmd('kette update'), 'WARNkette update');
  configure({}, { TERM: 'xterm-256color' }, { out: false, err: true });
  assert.equal(status('ok', 'OK'), 'OK');
  assert.match(toStderr.status('fail', 'FAIL'), /\x1b\[/);
});

test('a damaged state.json warns on stderr without escape codes when stderr is not a terminal', () => {
  const kh = tmp();
  fs.writeFileSync(path.join(kh, 'state.json'), '{broken');
  const r = kette(['doctor', '--ci'], { KETTE_HOME: kh, TERM: 'xterm-256color' });
  assert.match(r.stderr, /WARN .*state\.json is not readable/);
  assert.doesNotMatch(r.stderr, /\x1b/);
});
