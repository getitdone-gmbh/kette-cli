import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectPlatform, detectStack } from '../src/detect.mjs';
import { describe as describePlan, apply } from '../src/plan.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kette-test-'));
const write = (dir, f, c) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); };

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
  assert.deepEqual(described.map((x) => x.action), ['vorhanden', 'ergänzen', 'neu']);
  apply(described, d);
  assert.equal(fs.readFileSync(path.join(d, '.kette/profile.json'), 'utf8'), '{"alt":true}');
  assert.match(fs.readFileSync(path.join(d, 'CLAUDE.md'), 'utf8'), /# Projekt\n\n@\.kette\/README\.md/);
  assert.equal(describePlan(plan, d)[1].action, 'vorhanden');
});
