import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmp, write } from './helpers.mjs';
import { detectPlatform, detectStack } from '../src/detect.mjs';
import { describe as describePlan, apply } from '../src/plan.mjs';


test('erkennt Next.js und NestJS mit Prisma im Monorepo', () => {
  const d = tmp();
  write(d, 'apps/web/package.json', JSON.stringify({ dependencies: { next: '16' } }));
  write(d, 'apps/api/package.json', JSON.stringify({ dependencies: { '@nestjs/core': '11', '@prisma/client': '7' } }));
  assert.deepEqual(detectStack(d).sort(), ['nestjs-prisma', 'nextjs-ts-tailwind']);
});

test('erkennt Mongoose, Expo und FastAPI', () => {
  const d = tmp();
  write(d, 'package.json', JSON.stringify({ dependencies: { '@nestjs/core': '11', mongoose: '8', expo: '52' } }));
  write(d, 'svc/pyproject.toml', 'dependencies = ["fastapi>=0.110"]');
  assert.deepEqual(detectStack(d).sort(), ['nestjs-mongoose', 'python-fastapi', 'react-native-expo']);
});

test('erkennt Plattformen an CI- und IaC-Dateien', () => {
  const cases = [
    ['azure-pipelines.yml', 'trigger: [main]', 'azure-devops'],
    ['.gitlab-ci.yml', 'stages: [test]', 'gitlab'],
    ['.woodpecker.yml', 'steps: []', 'oss-selfhosted'],
    ['infra/main.tf', 'provider "aws" {}', 'aws-github'],
    ['.github/workflows/ci.yml', 'on: push', 'github-docker'],
  ];
  for (const [f, c, want] of cases) { const d = tmp(); write(d, f, c); assert.equal(detectPlatform(d), want, f); }
  assert.equal(detectPlatform(tmp()), null);
});

test('Plan überschreibt nie und ergänzt nur mit Marker', () => {
  const d = tmp();
  write(d, 'CLAUDE.md', '# Projekt\n');
  write(d, '.kette/profile.json', '{"alt":true}');
  const plan = [
    { path: '.kette/profile.json', content: '{"neu":true}' },
    { path: 'CLAUDE.md', mode: 'append', marker: '@.kette/README.md', content: '@.kette/README.md\n' },
    { path: 'docs/adr/0000-vorlage.md', content: 'x' },
  ];
  const described = describePlan(plan, d);
  assert.deepEqual(described.map((x) => x.action), ['keep', 'append', 'create']);
  apply(described, d);
  assert.equal(fs.readFileSync(path.join(d, '.kette/profile.json'), 'utf8'), '{"alt":true}');
  assert.match(fs.readFileSync(path.join(d, 'CLAUDE.md'), 'utf8'), /# Projekt\n\n@\.kette\/README\.md/);
  assert.equal(describePlan(plan, d)[1].action, 'keep');
});

test('without a terminal a question stops with exit code 2 and a hint instead of a crash', { skip: process.platform === 'win32' && 'detached has no setsid on Windows' }, () => {
  const bin = fileURLToPath(new URL('../bin/kette.mjs', import.meta.url));
  // detached runs in a new session without a controlling terminal, like CI, Docker or an agent shell
  const r = spawnSync(process.execPath, [bin, 'init'], { cwd: tmp(), env: { ...process.env, KETTE_HOME: tmp() }, stdio: ['ignore', 'pipe', 'pipe'], detached: true, encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.equal(r.stderr.trim(), 'kette: No terminal. Use --yes with --stack/--platform/--patterns.');
});

test('arguments named like Object prototype keys stay positional, never a flag', async () => {
  const { parse } = await import('../src/cli.mjs');
  for (const key of ['toString', '__proto__', 'constructor', 'hasOwnProperty']) {
    assert.deepEqual(parse(['rules', key]), { _: ['rules', key] }, key);
  }
});

test('unknown options and options without a value stop with exit code 2 and the help', async () => {
  const { main, parse } = await import('../src/cli.mjs');
  assert.throws(() => parse(['init', '--stak', 'x']), /Unknown option --stak/);
  assert.throws(() => parse(['init', '--stack']), /--stack needs a value/);
  assert.throws(() => parse(['init', '--stack', '--yes']), /--stack needs a value/);
  assert.deepEqual(parse(['init', 'proj', '-y', '--stack', 'a,b', '--no-color']), { _: ['init', 'proj'], yes: true, stack: 'a,b', color: false });
  const errors = [];
  const logs = [];
  const [err, log] = [console.error, console.log];
  console.error = (m) => errors.push(m);
  console.log = (m) => logs.push(m);
  try { assert.equal(await main(['doctor', '--frobnicate']), 2); } finally { [console.error, console.log] = [err, log]; }
  assert.match(errors.join('\n'), /^kette: Unknown option --frobnicate/);
  assert.match(logs.join('\n'), /^[●*] DIE KETTE  kette \d+\.\d+\.\d+ [·-] Community\n\nSet up the rules/);
});

test('plan never writes through a dangling symlink', { skip: process.platform === 'win32' }, () => {
  const d = tmp();
  const outside = path.join(tmp(), 'outside.md');
  fs.mkdirSync(path.join(d, 'docs'));
  fs.symlinkSync(outside, path.join(d, 'docs', 'note.md'));
  const described = describePlan([{ path: 'docs/note.md', content: 'x' }], d);
  assert.equal(described[0].action, 'keep');
  assert.match(described[0].note, /dangling symlink/);
  apply(described, d);
  assert.equal(fs.existsSync(outside), false);
  assert.throws(() => apply([{ path: 'docs/note.md', content: 'x', action: 'create' }], d), /EEXIST/);
  assert.equal(fs.existsSync(outside), false);
});
