import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { capture, tmp, write } from './helpers.mjs';
import { main } from '../src/cli.mjs';
import { detectApps, detectWorkspace } from '../src/detect.mjs';

const STACKS = ['nextjs-ts-tailwind', 'nestjs-prisma', 'nestjs-mongoose', 'python-fastapi', 'react-native-expo'];
const DEFAULTS = { 'nextjs-ts-tailwind': 'apps/web', 'nestjs-prisma': 'apps/api', 'nestjs-mongoose': 'apps/api', 'python-fastapi': 'apps/api', 'react-native-expo': 'apps/mobile' };
// Same pattern as apps in the schema of kette-engineering
const APP_FOLDER = '^(\\.|(?!(.*/)?\\.\\.?(/|$))[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*/?)$';
let kh;

// Enterprise bundle with the layout of kette-engineering: schema with apps, stack index, checks and github-docker templates as data
function bundle({ apps = true } = {}) {
  const d = path.join(kh, 'bundles', 'enterprise', '0.1.0');
  write(d, 'rules/architecture/adr-vorlage.md', '# ADR-Vorlage\n');
  if (apps) write(d, 'rules/architecture/adr-template.md', '# ADR template\n');
  write(d, 'schema/profile.schema.json', JSON.stringify({
    type: 'object',
    additionalProperties: false,
    required: ['version', 'project', 'stack', 'platform', 'patterns'],
    properties: {
      $schema: { type: 'string' }, version: { const: 1 }, project: { type: 'object' },
      stack: { type: 'array', items: { enum: STACKS } },
      ...(apps ? { apps: { type: 'object', additionalProperties: false, properties: Object.fromEntries(STACKS.map((s) => [s, { type: 'string', minLength: 1, default: DEFAULTS[s], pattern: APP_FOLDER }])) } } : {}),
      platform: { type: 'object', required: ['id'], properties: { id: { enum: ['github-docker', 'gitlab'] } } }, patterns: { type: 'array' }, tier: { enum: ['community', 'enterprise'] },
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
  write(d, 'checks/render/index.json', JSON.stringify({ files: [
    { from: 'tsconfig.strict.json', to: 'tsconfig.base.json', when: 'ts' },
    { from: 'eslint.config.mjs', to: 'eslint.config.mjs', when: 'ts', replace: { 'apps/web/': '[[web/]]' } },
    { from: 'gitleaks.toml', to: '.gitleaks.toml' },
  ] }));
  write(d, 'checks/render/tsconfig.strict.json', '{}\n');
  write(d, 'checks/render/eslint.config.mjs', "// kette:if web\nconst WEB = 'apps/web/**';\n// kette:end\n");
  write(d, 'checks/render/gitleaks.toml', '# gitleaks\n');
  const tpl = 'profiles/platform/github-docker/render';
  write(d, `${tpl}/index.json`, JSON.stringify({
    apps: {
      'nextjs-ts-tailwind': { manifests: ['[[dir/]]package.json'], files: [{ from: 'next/Dockerfile', to: '[[dir/]]Dockerfile' }] },
      'nestjs-prisma': { manifests: ['[[dir/]]package.json', 'tools/migrate/package.json'], files: [{ from: 'nest/Dockerfile', to: '[[dir/]]Dockerfile' }, { from: 'nest/migrate-package.json', to: 'tools/migrate/package.json', when: 'workspace', note: 'template, add tools/migrate to the workspaces' }] },
      'python-fastapi': { files: [{ from: 'py/Dockerfile', to: '[[dir/]]Dockerfile' }] },
      'react-native-expo': { skip: 'mobile app, no container' },
    },
    files: [{ from: 'root/compose.yaml', to: 'compose.yaml' }, { from: 'root/ci.yml', to: '.github/workflows/ci.yml' }],
  }));
  write(d, `${tpl}/next/Dockerfile`, 'FROM node\n# kette:if workspace\n[[manifests]]\n# kette:end\nCOPY [[dir]] [[dir]]\n');
  write(d, `${tpl}/nest/Dockerfile`, 'FROM node\nCOPY [[dir]] [[dir]]\n');
  write(d, `${tpl}/nest/migrate-package.json`, '{ "name": "migrate", "private": true }\n');
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
  const always = ['.kette/profile.json', '.kette/README.md', '.kette/templates.json', 'CLAUDE.md', 'docs/adr/0000-template.md', 'docs/adr/0000-vorlage.md'];
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
  assert.deepEqual(files(root), ['.github/workflows/ci.yml', '.gitleaks.toml', 'apps/api/Dockerfile', 'compose.yaml', 'eslint.config.mjs', 'package.json', 'tools/migrate/package.json', 'tsconfig.base.json']);
  assert.doesNotMatch(read(root, 'compose.yaml') + read(root, 'eslint.config.mjs'), /web/);
});

test('init of a new Node project writes the root package.json the workspace templates need, a Python project gets none', async () => {
  install(bundle());
  const { root, out } = await init('nestjs-prisma');
  assert.deepEqual(JSON.parse(read(root, 'package.json')), { private: true, workspaces: ['apps/api', 'tools/migrate'] });
  assert.match(out, /\+ create +package\.json +\(npm workspaces for the apps\)/);
  assert.match(out, /\+ create +tools\/migrate\/package\.json +\(template, listed in the root workspaces\)/);
  assert.doesNotMatch(out, /add tools\/migrate to the workspaces/);
  const py = await init('python-fastapi');
  assert.equal(fs.existsSync(path.join(py.root, 'package.json')), false);
});

test('add never writes a root package.json; with npm workspaces the migrate hint stays', async () => {
  install(bundle());
  const root = tmp();
  const own = JSON.stringify({ name: 'mine', workspaces: ['backend'] }) + '\n';
  write(root, 'package.json', own);
  write(root, 'backend/package.json', JSON.stringify({ dependencies: { '@nestjs/core': '11', '@prisma/client': '7' } }));
  const cwd = process.cwd();
  process.chdir(root);
  let out;
  try {
    ({ out } = await capture(() => main(['add', '--yes', '--no-plugins', '--platform', 'github-docker', '--patterns', 'layered'])));
  } finally {
    process.chdir(cwd);
  }
  assert.equal(read(root, 'package.json'), own);
  assert.match(out, /tools\/migrate\/package\.json +\(template, add tools\/migrate to the workspaces\)/);
});

test('an existing profile without platform: templates and checks skipped with the schema error, no crash', async () => {
  install(bundle());
  const root = tmp();
  write(root, '.kette/profile.json', JSON.stringify({ version: 1, project: { name: 'x' }, stack: ['nestjs-prisma'], apps: { 'nestjs-prisma': 'api' }, patterns: ['layered'], tier: 'enterprise' }, null, 2) + '\n');
  const cwd = process.cwd();
  process.chdir(root);
  let out;
  try {
    ({ out } = await capture(() => main(['add', '--yes', '--no-plugins', '--platform', 'github-docker'])));
  } finally {
    process.chdir(cwd);
  }
  assert.match(out, /\.kette\/profile\.json is not valid \(\$: required field platform is missing\), platform templates and checks are skipped\. Fix the profile, then run kette add again\./);
  assert.deepEqual(files(root), []);
});

test('init nextjs + nestjs: new monorepo with apps/web and apps/api as npm workspaces', async () => {
  install(bundle());
  const { root } = await init('nextjs-ts-tailwind,nestjs-prisma');
  assert.deepEqual(files(root), ['.github/workflows/ci.yml', '.gitleaks.toml', 'apps/api/Dockerfile', 'apps/web/Dockerfile', 'compose.yaml', 'eslint.config.mjs', 'package.json', 'tools/migrate/package.json', 'tsconfig.base.json']);
  assert.match(read(root, 'apps/web/Dockerfile'), /COPY apps\/api\/package\.json apps\/api\/\nCOPY apps\/web\/package\.json apps\/web\/\nCOPY tools\/migrate\/package\.json tools\/migrate\//);
  assert.deepEqual(JSON.parse(read(root, 'package.json')).workspaces, ['apps/web', 'apps/api', 'tools/migrate']);
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
  assert.deepEqual(files(root), ['.gitleaks.toml', 'eslint.config.mjs', 'package.json', 'tsconfig.base.json']);
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
  write(d, 'checks/render/index.json', JSON.stringify({ format: 2, files: [] }));
  install(d);
  const { root, out } = await init('nestjs-prisma');
  assert.match(out, REINSTALL);
  assert.match(out.match(REINSTALL)[1], /checks\/render\/index\.json has format 2/);
  assert.deepEqual(files(root), []);
  assert.ok(fs.existsSync(path.join(root, '.kette/profile.json')));
});

test('a bundle template with a placeholder this CLI does not know: same reinstall hint instead of a crash', async () => {
  const d = bundle();
  write(d, 'profiles/platform/github-docker/render/root/ci.yml', 'jobs: [[queue]]\n');
  install(d);
  const { root, out } = await init('nestjs-prisma');
  assert.match(out.match(REINSTALL)?.[1] || '', /unknown placeholder \[\[queue\]\]/);
  assert.deepEqual(files(root), []);
});

test('Community init writes no apps; after the upgrade add detects the folders and puts the templates there', async () => {
  const d = bundle();
  // Community: no credentials, the same bundle as the installed Community rulebook
  fs.rmSync(path.join(kh, 'credentials'));
  fs.writeFileSync(path.join(kh, 'state.json'), JSON.stringify({ bundle_community: { version: '0.1.0', dir: bundle() } }));
  fs.writeFileSync(path.join(kh, 'state.json'), JSON.stringify({ bundle_community: { version: '0.1.0', dir: d } }));
  const { root } = await init('nestjs-prisma');
  assert.equal('apps' in profileOf(root), false);
  assert.deepEqual(files(root), []);
  write(root, 'backend/package.json', JSON.stringify({ dependencies: { '@nestjs/core': '11', '@prisma/client': '7' } }));
  write(kh, 'credentials', JSON.stringify({ key: 'CDP-AAAAA-BBBBB-CCCCC-00001' }));
  install(d);
  await addIn(root);
  assert.equal(profileOf(root).tier, 'enterprise');
  assert.deepEqual(profileOf(root).apps, { 'nestjs-prisma': 'backend' });
  assert.ok(files(root).includes('backend/Dockerfile') && !files(root).some((f) => f.startsWith('apps/')));
});

const profileWith = (fields) => JSON.stringify({ version: 1, project: { name: 'x' }, stack: ['nestjs-prisma'], platform: { id: 'github-docker' }, patterns: ['layered'], tier: 'enterprise', ...fields }, null, 2) + '\n';

for (const [label, fields] of [
  ['a Windows-style app folder', { apps: { 'nestjs-prisma': '..\\..\\evil' } }],
  ['a UNC app folder', { apps: { 'nestjs-prisma': '\\\\server\\share' } }],
  ['an app folder with ..', { apps: { 'nestjs-prisma': 'a/../../evil' } }],
  ['a platform id with a path', { platform: { id: '../../checks' } }],
]) {
  test(`add with ${label} in the profile: nothing rendered, nothing written outside, the schema error is shown`, async () => {
    install(bundle());
    const parent = tmp();
    const root = path.join(parent, 'repo');
    write(root, '.kette/profile.json', profileWith(fields));
    const { out } = await addIn(root);
    assert.match(out, /\.kette\/profile\.json is not valid \(.*\), platform templates and checks are skipped/);
    assert.deepEqual(files(root), []);
    assert.deepEqual(fs.readdirSync(parent), ['repo']);
  });
}

test('apply refuses a plan with a path outside the project and writes nothing', async () => {
  const { apply } = await import('../src/plan.mjs');
  const parent = tmp();
  const root = path.join(parent, 'repo');
  fs.mkdirSync(root);
  const plan = [{ path: 'ok.txt', content: 'x', action: 'create' }, { path: '../evil.txt', content: 'x', action: 'create' }];
  assert.throws(() => apply(plan, root), /Refusing to write outside the project: \.\.\/evil\.txt/);
  assert.deepEqual(fs.readdirSync(parent), ['repo']);
  assert.deepEqual(fs.readdirSync(root), []);
});

test('a symlinked CLAUDE.md and a symlinked app folder pointing outside are left alone', { skip: process.platform === 'win32' }, async () => {
  install(bundle());
  const outside = tmp();
  write(outside, 'bashrc', 'export A=1\n');
  fs.mkdirSync(path.join(outside, 'api'));
  const root = tmp();
  write(root, '.kette/profile.json', profileWith({ apps: { 'nestjs-prisma': 'backend' } }));
  fs.symlinkSync(path.join(outside, 'bashrc'), path.join(root, 'CLAUDE.md'));
  fs.symlinkSync(path.join(outside, 'api'), path.join(root, 'backend'));
  const { out } = await addIn(root);
  assert.match(out, /= keep +CLAUDE\.md +\(symlink, left alone\)/);
  assert.match(out, /= keep +backend\/Dockerfile +\(folder links outside the project, left alone\)/);
  assert.equal(fs.readFileSync(path.join(outside, 'bashrc'), 'utf8'), 'export A=1\n');
  assert.deepEqual(fs.readdirSync(path.join(outside, 'api')), []);
});

test('a folder where a template file goes is kept with a note instead of crashing', async () => {
  install(bundle());
  const root = tmp();
  write(root, '.kette/profile.json', profileWith({}));
  fs.mkdirSync(path.join(root, 'compose.yaml'));
  const { out } = await addIn(root);
  assert.match(out, /= keep +compose\.yaml +\(a folder with this name exists, left alone\)/);
});

test('ADR template: English 0000-template.md for a new project, nothing new beside an existing 0000-vorlage.md, German file from an older bundle', async () => {
  install(bundle());
  const fresh = await init('nestjs-prisma');
  assert.equal(read(fresh.root, 'docs/adr/0000-template.md'), '# ADR template\n');
  assert.equal(fs.existsSync(path.join(fresh.root, 'docs/adr/0000-vorlage.md')), false);

  const old = tmp();
  write(old, 'docs/adr/0000-vorlage.md', '# Meine Vorlage\n');
  write(old, 'package.json', '{}');
  const { out } = await addIn(old, ['--stack', 'nestjs-prisma', '--platform', 'github-docker', '--patterns', 'layered']);
  assert.doesNotMatch(out, /0000-template/);
  assert.equal(fs.existsSync(path.join(old, 'docs/adr/0000-template.md')), false);
  assert.equal(read(old, 'docs/adr/0000-vorlage.md'), '# Meine Vorlage\n');

  fs.rmSync(path.join(bundle(), 'rules', 'architecture', 'adr-template.md'));
  const legacy = await init('nestjs-prisma');
  assert.equal(read(legacy.root, 'docs/adr/0000-vorlage.md'), '# ADR-Vorlage\n');
});

test('a detected folder the profile cannot hold ("Web App", umlauts) gets no apps entry and a hint; add finishes with a valid profile', async () => {
  const { detectAppFolders } = await import('../src/detect.mjs');
  const d = tmp();
  write(d, 'Web App/package.json', JSON.stringify({ dependencies: { next: '16' } }));
  write(d, 'Lösung/api/package.json', JSON.stringify({ dependencies: { '@nestjs/core': '11', '@prisma/client': '7' } }));
  assert.deepEqual(detectAppFolders(d), { apps: {}, unusable: { 'nextjs-ts-tailwind': 'Web App', 'nestjs-prisma': 'Lösung/api' } });

  install(bundle());
  const root = tmp();
  write(root, 'Web App/package.json', JSON.stringify({ dependencies: { next: '16' } }));
  write(root, 'backend/package.json', JSON.stringify({ dependencies: { '@nestjs/core': '11', '@prisma/client': '7' } }));
  const { out, result } = await addIn(root, ['--platform', 'github-docker', '--patterns', 'layered']);
  assert.equal(result, 0);
  assert.ok(out.includes('WARN Folder "Web App" (nextjs-ts-tailwind) can\'t be used as an app folder. Rename it (letters, digits, . _ - only) or point apps to another folder in .kette/profile.json.'), out);
  assert.deepEqual(profileOf(root).apps, { 'nestjs-prisma': 'backend' });
  assert.ok(files(root).includes('backend/Dockerfile'));
  assert.ok(!files(root).some((f) => f.startsWith('apps/')), 'no default folder for the skipped app');
  assert.match(out, /No templates for nextjs-ts-tailwind: folder "Web App" can't be used as an app folder/);

  const existing = tmp();
  write(existing, '.kette/profile.json', JSON.stringify({ version: 1, project: { name: 'x' }, stack: ['nextjs-ts-tailwind', 'nestjs-prisma'], platform: { id: 'github-docker' }, patterns: ['layered'], tier: 'community' }, null, 2) + '\n');
  write(existing, 'Web App/package.json', JSON.stringify({ dependencies: { next: '16' } }));
  write(existing, 'backend/package.json', JSON.stringify({ dependencies: { '@nestjs/core': '11', '@prisma/client': '7' } }));
  await addIn(existing);
  assert.deepEqual(profileOf(existing).apps, { 'nestjs-prisma': 'backend' });

  // Community: no credentials, the same bundle as the installed Community rulebook
  fs.rmSync(path.join(kh, 'credentials'));
  fs.writeFileSync(path.join(kh, 'state.json'), JSON.stringify({ bundle_community: { version: '0.1.0', dir: bundle() } }));
  const community = tmp();
  write(community, 'Web App/package.json', JSON.stringify({ dependencies: { next: '16' } }));
  assert.doesNotMatch((await addIn(community, ['--platform', 'github-docker', '--patterns', 'layered'])).out, /can't be used as an app folder/);
  assert.equal(profileOf(existing).tier, 'enterprise');
});
