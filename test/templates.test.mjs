import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { capture, tmp, write } from './helpers.mjs';
import { main } from '../src/cli.mjs';
import { detectApps, detectWorkspace } from '../src/detect.mjs';

const STACKS = ['nextjs-ts-tailwind', 'nestjs-prisma', 'nestjs-mongoose', 'python-fastapi', 'react-native-expo'];
const DEFAULTS = { 'nextjs-ts-tailwind': 'apps/web', 'nestjs-prisma': 'apps/api', 'nestjs-mongoose': 'apps/api', 'python-fastapi': 'apps/api', 'react-native-expo': 'apps/mobile' };
let kh;

// Enterprise bundle with the layout of kette-engineering: schema with apps, stack index, checks and github-docker templates as data
function bundle({ apps = true } = {}) {
  const d = path.join(kh, 'bundles', 'enterprise', '0.1.0');
  write(d, 'rules/architecture/adr-vorlage.md', '# ADR\n');
  write(d, 'schema/profile.schema.json', JSON.stringify({
    type: 'object',
    additionalProperties: false,
    required: ['version', 'project', 'stack', 'platform', 'patterns'],
    properties: {
      $schema: { type: 'string' }, version: { const: 1 }, project: { type: 'object' },
      stack: { type: 'array', items: { enum: STACKS } },
      ...(apps ? { apps: { type: 'object', additionalProperties: false, properties: Object.fromEntries(STACKS.map((s) => [s, { type: 'string', minLength: 1, default: DEFAULTS[s] }])) } } : {}),
      platform: { type: 'object' }, patterns: { type: 'array' }, tier: { enum: ['community', 'enterprise'] },
    },
  }));
  if (!apps) return d;
  write(d, 'profiles/stack/index.json', JSON.stringify({
    'nextjs-ts-tailwind': { role: 'web', flags: ['node', 'ts', 'next'] },
    'nestjs-prisma': { role: 'api', flags: ['node', 'ts', 'nest', 'prisma', 'postgres'] },
    'nestjs-mongoose': { role: 'api', flags: ['node', 'ts', 'nest', 'mongo'] },
    'python-fastapi': { role: 'api', flags: ['python', 'fastapi', 'postgres'] },
    'react-native-expo': { role: 'mobile', flags: ['node', 'ts', 'expo'] },
  }));
  write(d, 'checks/index.json', JSON.stringify({ files: [
    { from: 'tsconfig.strict.json', to: 'tsconfig.base.json', when: 'ts' },
    { from: 'eslint.config.mjs', to: 'eslint.config.mjs', when: 'ts', replace: { 'apps/web/': '[[web/]]' } },
    { from: 'gitleaks.toml', to: '.gitleaks.toml' },
  ] }));
  write(d, 'checks/tsconfig.strict.json', '{}\n');
  write(d, 'checks/eslint.config.mjs', "// kette:if web\nconst WEB = 'apps/web/**';\n// kette:end\n");
  write(d, 'checks/gitleaks.toml', '# gitleaks\n');
  const tpl = 'profiles/platform/github-docker/templates';
  write(d, `${tpl}/index.json`, JSON.stringify({
    apps: {
      'nextjs-ts-tailwind': { manifests: ['[[dir/]]package.json'], files: [{ from: 'next/Dockerfile', to: '[[dir/]]Dockerfile' }] },
      'nestjs-prisma': { manifests: ['[[dir/]]package.json'], files: [{ from: 'nest/Dockerfile', to: '[[dir/]]Dockerfile' }] },
      'python-fastapi': { files: [{ from: 'py/Dockerfile', to: '[[dir/]]Dockerfile' }] },
      'react-native-expo': { skip: 'mobile app, no container' },
    },
    files: [{ from: 'root/compose.yaml', to: 'compose.yaml' }, { from: 'root/ci.yml', to: '.github/workflows/ci.yml' }],
  }));
  write(d, `${tpl}/next/Dockerfile`, 'FROM node\n# kette:if workspace\n[[manifests]]\n# kette:end\nCOPY [[dir]] [[dir]]\n');
  write(d, `${tpl}/nest/Dockerfile`, 'FROM node\nCOPY [[dir]] [[dir]]\n');
  write(d, `${tpl}/py/Dockerfile`, 'FROM python\nCOPY [[dir]] [[dir]]\n');
  write(d, `${tpl}/root/compose.yaml`, 'services:\n# kette:if api\n  api: { dockerfile: [[api/]]Dockerfile }\n# kette:end\n# kette:if web\n  web: { dockerfile: [[web/]]Dockerfile }\n# kette:end\n');
  write(d, `${tpl}/root/ci.yml`, 'jobs:\n# kette:if node\n  node: npm ci\n# kette:end\n# kette:if python\n  python: uv sync\n# kette:end\n');
  return d;
}

beforeEach(() => {
  kh = tmp();
  process.env.KETTE_HOME = kh;
  write(kh, 'credentials', JSON.stringify({ key: 'CDP-AAAAA-BBBBB-CCCCC-00001' }));
});

function install(dir) {
  fs.writeFileSync(path.join(kh, 'state.json'), JSON.stringify({ bundle_enterprise: { version: '0.1.0', dir } }));
}

// Files in the project without .git and the files kette always writes
function files(root) {
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.name === '.git' ? [] : e.isDirectory() ? walk(path.join(dir, e.name)) : [path.relative(root, path.join(dir, e.name)).split(path.sep).join('/')]));
  const always = ['.kette/profile.json', '.kette/README.md', 'CLAUDE.md', 'docs/adr/0000-vorlage.md'];
  return walk(root).filter((f) => !always.includes(f)).sort();
}
const read = (root, f) => fs.readFileSync(path.join(root, f), 'utf8');
const profileOf = (root) => JSON.parse(read(root, '.kette/profile.json'));

async function init(stack) {
  const root = path.join(tmp(), 'p');
  const { out } = await capture(() => main(['init', root, '--yes', '--no-plugins', '--stack', stack, '--platform', 'github-docker', '--patterns', 'layered']));
  return { root, out };
}

test('detectApps finds backend/ and frontend/, apps/* and skips the root of an npm workspace', () => {
  const d = tmp();
  write(d, 'backend/package.json', JSON.stringify({ dependencies: { '@nestjs/core': '11', '@prisma/client': '7' } }));
  write(d, 'frontend/package.json', JSON.stringify({ dependencies: { next: '16' } }));
  write(d, 'services/py/pyproject.toml', 'dependencies = ["fastapi"]');
  assert.deepEqual(detectApps(d), { 'nestjs-prisma': 'backend', 'nextjs-ts-tailwind': 'frontend', 'python-fastapi': 'services/py' });
  assert.equal(detectWorkspace(d), false);
  const w = tmp();
  write(w, 'package.json', JSON.stringify({ workspaces: ['apps/*'], devDependencies: { next: '16' } }));
  write(w, 'apps/web/package.json', JSON.stringify({ dependencies: { next: '16' } }));
  assert.deepEqual(detectApps(w), { 'nextjs-ts-tailwind': 'apps/web' });
  assert.equal(detectWorkspace(w), true);
  const single = tmp();
  write(single, 'package.json', JSON.stringify({ dependencies: { next: '16' } }));
  assert.deepEqual(detectApps(single), { 'nextjs-ts-tailwind': '.' });
});

test('init python-fastapi: Python Dockerfile, compose and CI without web, Node or TypeScript checks', async () => {
  install(bundle());
  const { root } = await init('python-fastapi');
  assert.deepEqual(files(root), ['.github/workflows/ci.yml', '.gitleaks.toml', 'apps/api/Dockerfile', 'compose.yaml']);
  assert.match(read(root, 'apps/api/Dockerfile'), /^FROM python/);
  assert.equal(read(root, 'compose.yaml'), 'services:\n  api: { dockerfile: apps/api/Dockerfile }\n');
  assert.equal(read(root, '.github/workflows/ci.yml'), 'jobs:\n  python: uv sync\n');
  assert.deepEqual(profileOf(root).apps, { 'python-fastapi': 'apps/api' });
});

test('init nestjs-prisma: only the API, no web app anywhere', async () => {
  install(bundle());
  const { root } = await init('nestjs-prisma');
  assert.deepEqual(files(root), ['.github/workflows/ci.yml', '.gitleaks.toml', 'apps/api/Dockerfile', 'compose.yaml', 'eslint.config.mjs', 'tsconfig.base.json']);
  assert.doesNotMatch(read(root, 'compose.yaml') + read(root, 'eslint.config.mjs'), /web/);
});

test('init nextjs + nestjs: new monorepo with apps/web and apps/api as npm workspaces', async () => {
  install(bundle());
  const { root } = await init('nextjs-ts-tailwind,nestjs-prisma');
  assert.deepEqual(files(root), ['.github/workflows/ci.yml', '.gitleaks.toml', 'apps/api/Dockerfile', 'apps/web/Dockerfile', 'compose.yaml', 'eslint.config.mjs', 'tsconfig.base.json']);
  assert.match(read(root, 'apps/web/Dockerfile'), /COPY apps\/api\/package\.json apps\/api\/\nCOPY apps\/web\/package\.json apps\/web\//);
  assert.deepEqual(profileOf(root).apps, { 'nextjs-ts-tailwind': 'apps/web', 'nestjs-prisma': 'apps/api' });
});

test('add on backend/ (NestJS) and frontend/ (Next.js): templates in those folders, profile names them, existing files stay', async () => {
  install(bundle());
  const root = tmp();
  write(root, 'backend/package.json', JSON.stringify({ dependencies: { '@nestjs/core': '11', '@prisma/client': '7' } }));
  write(root, 'frontend/package.json', JSON.stringify({ dependencies: { next: '16' } }));
  write(root, 'frontend/Dockerfile', 'FROM my-own\n');
  const cwd = process.cwd();
  process.chdir(root);
  try {
    const { out } = await capture(() => main(['add', '--yes', '--no-plugins', '--platform', 'github-docker', '--patterns', 'layered']));
    assert.match(out, /App folders: nestjs-prisma backend, nextjs-ts-tailwind frontend/);
  } finally {
    process.chdir(cwd);
  }
  assert.deepEqual(files(root), ['.github/workflows/ci.yml', '.gitleaks.toml', 'backend/Dockerfile', 'backend/package.json', 'compose.yaml', 'eslint.config.mjs', 'frontend/Dockerfile', 'frontend/package.json', 'tsconfig.base.json']);
  assert.equal(read(root, 'frontend/Dockerfile'), 'FROM my-own\n');
  assert.equal(read(root, 'backend/Dockerfile'), 'FROM node\nCOPY backend backend\n');
  assert.equal(read(root, 'compose.yaml'), 'services:\n  api: { dockerfile: backend/Dockerfile }\n  web: { dockerfile: frontend/Dockerfile }\n');
  assert.equal(read(root, 'eslint.config.mjs'), "const WEB = 'frontend/**';\n");
  assert.deepEqual(profileOf(root).apps, { 'nestjs-prisma': 'backend', 'nextjs-ts-tailwind': 'frontend' });
});

test('add follows the folders of an existing profile and never rewrites it', async () => {
  install(bundle());
  const root = tmp();
  const own = JSON.stringify({ version: 1, project: { name: 'x' }, stack: ['python-fastapi'], apps: { 'python-fastapi': 'svc' }, platform: { id: 'github-docker' }, patterns: ['layered'], tier: 'enterprise' }, null, 2) + '\n';
  write(root, '.kette/profile.json', own);
  const cwd = process.cwd();
  process.chdir(root);
  try {
    await capture(() => main(['add', '--yes', '--no-plugins']));
  } finally {
    process.chdir(cwd);
  }
  assert.equal(read(root, '.kette/profile.json'), own);
  assert.ok(files(root).includes('svc/Dockerfile'));
  assert.ok(!files(root).some((f) => f.startsWith('apps/')));
});

test('react-native-expo gets no container files and the reason is shown', async () => {
  install(bundle());
  const { root, out } = await init('react-native-expo');
  assert.deepEqual(files(root), ['.gitleaks.toml', 'eslint.config.mjs', 'tsconfig.base.json']);
  assert.match(out, /No templates for react-native-expo: mobile app, no container/);
});

test('an older bundle without apps in the schema: no apps field, no templates, hint to update', async () => {
  install(bundle({ apps: false }));
  const { root, out } = await init('nestjs-prisma');
  assert.equal('apps' in profileOf(root), false);
  assert.deepEqual(files(root), []);
  assert.match(out, /no profile-aware templates yet, load the current one with: kette update/);
});

async function addIn(root, args = []) {
  const cwd = process.cwd();
  process.chdir(root);
  try {
    return await capture(() => main(['add', '--yes', '--no-plugins', ...args]));
  } finally {
    process.chdir(cwd);
  }
}

test('add on a Community profile without apps: tier raised, detected apps added after stack, every other field stays', async () => {
  install(bundle());
  const root = tmp();
  write(root, 'backend/package.json', JSON.stringify({ dependencies: { '@nestjs/core': '11', '@prisma/client': '7' } }));
  write(root, 'frontend/package.json', JSON.stringify({ dependencies: { next: '16' } }));
  const own = { version: 1, project: { name: 'mine' }, stack: ['nestjs-prisma', 'nextjs-ts-tailwind'], platform: { id: 'github-docker' }, patterns: ['hexagonal', 'cqrs'], tier: 'community' };
  write(root, '.kette/profile.json', JSON.stringify(own, null, 2) + '\n');
  const { out } = await addIn(root);
  assert.match(out, /~ update\s+\.kette\/profile\.json/);
  const raw = read(root, '.kette/profile.json');
  assert.deepEqual(JSON.parse(raw), { ...own, tier: 'enterprise', apps: { 'nestjs-prisma': 'backend', 'nextjs-ts-tailwind': 'frontend' } });
  assert.deepEqual(Object.keys(JSON.parse(raw)), ['version', 'project', 'stack', 'apps', 'platform', 'patterns', 'tier']);
  assert.ok(['backend/Dockerfile', 'frontend/Dockerfile'].every((f) => files(root).includes(f)));
});

test('add on a profile without apps while the installed schema has no apps: profile stays byte for byte', async () => {
  install(bundle({ apps: false }));
  const root = tmp();
  write(root, 'backend/package.json', JSON.stringify({ dependencies: { '@nestjs/core': '11', '@prisma/client': '7' } }));
  const own = JSON.stringify({ version: 1, project: { name: 'mine' }, stack: ['nestjs-prisma'], platform: { id: 'github-docker' }, patterns: ['layered'], tier: 'enterprise' }, null, 4) + '\n';
  write(root, '.kette/profile.json', own);
  await addIn(root);
  assert.equal(read(root, '.kette/profile.json'), own);
});

const REINSTALL = /newer than this CLI understands \((.+)\), platform templates and checks are skipped\. Reinstall the CLI: curl -fsSL https:\/\/kette\.itdone\.de\/install \| sh \(Windows: irm https:\/\/kette\.itdone\.de\/install\.ps1 \| iex\)/;

test('a bundle with a newer template format: reinstall hint for macOS, Linux and Windows, rules still set up, no templates', async () => {
  const d = bundle();
  write(d, 'checks/index.json', JSON.stringify({ format: 2, files: [] }));
  install(d);
  const { root, out } = await init('nestjs-prisma');
  assert.match(out, REINSTALL);
  assert.match(out.match(REINSTALL)[1], /checks\/index\.json has format 2/);
  assert.deepEqual(files(root), []);
  assert.ok(fs.existsSync(path.join(root, '.kette/profile.json')));
});

test('a bundle template with a placeholder this CLI does not know: same reinstall hint instead of a crash', async () => {
  const d = bundle();
  write(d, 'profiles/platform/github-docker/templates/root/ci.yml', 'jobs: [[queue]]\n');
  install(d);
  const { root, out } = await init('nestjs-prisma');
  assert.match(out.match(REINSTALL)?.[1] || '', /unknown placeholder \[\[queue\]\]/);
  assert.deepEqual(files(root), []);
});
