import fs from 'node:fs';
import path from 'node:path';

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const exists = (dir, f) => fs.existsSync(path.join(dir, f));
const listFiles = (dir, depth = 2) => {
  if (depth < 0 || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (['node_modules', '.git', 'dist', '.next', 'build'].includes(e.name)) return [];
    const p = path.join(dir, e.name);
    return e.isDirectory() ? listFiles(p, depth - 1) : [p];
  });
};

// Full-stack and native React frameworks that also use Vite or React but are no single page app
const NOT_SPA = ['next', 'expo', 'react-native', '@react-router/dev', '@tanstack/react-start'];

// A Vite React app with its own index.html; a library (React as peer dependency) or a framework app does not count
function isReactSpa(file, pkg, deps) {
  if (!deps.vite || !deps.react || pkg.peerDependencies?.react) return false;
  if (NOT_SPA.some((d) => deps[d]) || Object.keys(deps).some((d) => d.startsWith('@remix-run/'))) return false;
  return exists(path.dirname(file), 'index.html');
}

// Stacks of one manifest: package.json, pyproject.toml or requirements.txt
function stacksOf(file) {
  if (path.basename(file) !== 'package.json') return /fastapi/i.test(fs.readFileSync(file, 'utf8')) ? ['python-fastapi'] : [];
  const p = readJson(file) || {};
  const deps = { ...p.dependencies, ...p.devDependencies };
  const stacks = [];
  if (deps.next) stacks.push('nextjs-ts-tailwind');
  if (deps['@nestjs/core'] && (deps['@prisma/client'] || deps.prisma)) stacks.push('nestjs-prisma');
  else if (deps['@nestjs/core'] && (deps.mongoose || deps['@nestjs/mongoose'])) stacks.push('nestjs-mongoose');
  else if (deps['@nestjs/core']) stacks.push('nestjs-prisma');
  if (deps.expo) stacks.push('react-native-expo');
  else if (isReactSpa(file, p, deps)) stacks.push('react-spa');
  return stacks;
}

const manifests = (dir) => [
  ...listFiles(dir, 3).filter((f) => path.basename(f) === 'package.json'),
  ...listFiles(dir, 2).filter((f) => /(pyproject\.toml|requirements\.txt)$/.test(f)),
];

// Signs of an app kette has no app stack for (Express, Vue, Angular, SvelteKit, Spring, Django, Go, Rust, ...): such a repo gets no repo stack, it stops and asks for --stack (KETTE-57, CR-DET-1)
const APP_DEPS = ['express', 'fastify', 'koa', 'hono', '@hapi/hapi', '@nestjs/core', 'next', 'nuxt', 'vue', 'svelte', '@sveltejs/kit', '@angular/core', 'solid-js', 'preact', 'react-native', 'expo', 'electron', '@react-router/dev', '@tanstack/react-start'];
const OTHER_MANIFESTS = ['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'go.mod', 'Cargo.toml', 'manage.py', 'Gemfile', 'composer.json', 'pyproject.toml', 'requirements.txt', 'setup.py', 'Pipfile', 'mix.exs', 'Package.swift', 'pubspec.yaml'];
const OTHER_PROJECT = /\.(csproj|fsproj|sln)$/;

function hasAppDeps(file) {
  if (path.basename(file) !== 'package.json') return false;
  const p = readJson(file) || {};
  const deps = { ...p.dependencies, ...p.devDependencies };
  // react-dom as a runtime dependency renders an app; a component library keeps it in dev or peer dependencies
  return APP_DEPS.some((d) => deps[d]) || Object.keys(deps).some((d) => d.startsWith('@remix-run/')) || Boolean(p.dependencies?.['react-dom']);
}

const hasAppSignal = (dir, found) => found.some(hasAppDeps) || listFiles(dir, 3).some((f) => OTHER_MANIFESTS.includes(path.basename(f)) || OTHER_PROJECT.test(f));

// Static site generators; without one a build script next to HTML pages at the root or in src/ counts as a static site
const SITE_GENERATORS = ['astro', '@11ty/eleventy'];
const hasPages = (dir) => listFiles(dir, 0).some((f) => f.endsWith('.html')) || listFiles(path.join(dir, 'src'), 2).some((f) => f.endsWith('.html'));
const isTypeScript = (file, p, deps) => Boolean(p.types || p.typings || deps.typescript) || exists(path.dirname(file), 'tsconfig.json');
const binTargets = (p) => (typeof p.bin === 'string' ? [p.bin] : Object.values(p.bin || {})).map((f) => path.posix.normalize(String(f)));
// The entry other code imports: exports, or main when it is not one of the bin scripts
const importEntry = (p) => Boolean(p.exports) || (Boolean(p.main) && !binTargets(p).includes(path.posix.normalize(String(p.main))));

// Repo stack of one package.json (a repository that is not an app): a TypeScript package with a public API, a CLI with bin, a static site
function repoStackOf(file) {
  if (path.basename(file) !== 'package.json') return null;
  const p = readJson(file) || {};
  const deps = { ...p.dependencies, ...p.devDependencies };
  // A library may carry a small bin facade beside its own import entry; a bin with types only is a CLI (CR-DET-3)
  if (importEntry(p) && isTypeScript(file, p, deps)) return 'ts-library';
  if (p.bin) return 'node-cli';
  if (p.exports || p.main || p.types) return null;
  if (SITE_GENERATORS.some((d) => deps[d]) || (p.scripts?.build && hasPages(path.dirname(file)))) return 'static-site';
  return null;
}

// README, CHANGELOG and the like at the root, agent notes and the files kette writes come with many repos and make no docs repo
const ROOT_TEXT = /^(README|CHANGELOG|LICENSE|CONTRIBUTING|CODE_OF_CONDUCT|SECURITY)(\.|$)/i;
const AGENT_NOTES = ['CLAUDE.md', 'AGENTS.md'];
const KETTE_ADR_TEMPLATE = /^docs\/adr\/0000-/;
const CODE = /\.(m?[jt]sx?|c[jt]s|py|go|rs|java|kt|kts|scala|swift|rb|php|cs|fs|vue|svelte|sh|html|css)$/i;
// Folders of dependencies, build output and tools; dot folders (.github, .kette, .claude) are skipped as a whole
const NOT_SOURCE = ['node_modules', 'vendor', 'dist', 'build', 'target', 'coverage', 'out'];
// A few pages of their own, so a starter repo with a README stays empty
const MIN_DOCS_PAGES = 3;

// Every file of the repo without dependencies, build output and dot folders, at any depth
const sourceFiles = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  if (e.name.startsWith('.') || NOT_SOURCE.includes(e.name)) return [];
  const p = path.join(dir, e.name);
  return e.isDirectory() ? sourceFiles(p) : [p];
});

// Mostly Markdown: at least a few pages of its own and more Markdown pages than code files
function isDocs(dir) {
  const files = sourceFiles(dir).map((f) => path.relative(dir, f).split(path.sep).join('/'));
  const pages = files.filter((f) => /\.mdx?$/i.test(f) && !(!f.includes('/') && ROOT_TEXT.test(f)) && !AGENT_NOTES.includes(path.posix.basename(f)) && !KETTE_ADR_TEMPLATE.test(f));
  return pages.length >= MIN_DOCS_PAGES && pages.length > files.filter((f) => CODE.test(f)).length;
}

// Detects stacks from the package files in the repo and in apps/*, packages/*
// Repo stacks (node-cli, ts-library, static-site, docs) only without any sign of an app, so an app kette has no stack for stops instead of losing its rules
export function detectStack(dir) {
  const found = manifests(dir);
  const apps = [...new Set(found.flatMap(stacksOf))];
  if (apps.length) return apps;
  if (!fs.existsSync(dir) || hasAppSignal(dir, found)) return [];
  const repo = [...new Set(found.map(repoStackOf).filter(Boolean))];
  if (repo.length) return repo;
  return isDocs(dir) ? ['docs'] : [];
}

// Same rule as apps in the profile schema: plain folder names joined by /, so a detected folder always makes a valid profile
export const APP_FOLDER_PATTERN = '^(\\.|(?!(.*/)?\\.\\.?(/|$))[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*/?)$';
const APP_FOLDER = new RegExp(APP_FOLDER_PATTERN);

// App folder per stack, relative with / (e.g. backend, frontend, apps/web); the least nested manifest wins, the root of an npm workspace never counts
// unusable: stacks found only in folders whose name the profile cannot hold (spaces, umlauts), they get no apps entry
export function detectAppFolders(dir) {
  const depth = (rel) => (rel === '.' ? 0 : rel.split('/').length);
  const found = manifests(dir)
    .map((f) => ({ f, rel: path.relative(dir, path.dirname(f)).split(path.sep).join('/') || '.' }))
    .filter(({ f, rel }) => !(rel === '.' && readJson(f)?.workspaces))
    .sort((a, b) => depth(a.rel) - depth(b.rel) || a.rel.localeCompare(b.rel));
  const apps = {};
  const unusable = {};
  for (const { f, rel } of found) {
    for (const stack of stacksOf(f)) {
      if (APP_FOLDER.test(rel)) apps[stack] ??= rel;
      else unusable[stack] ??= rel;
    }
  }
  for (const stack of Object.keys(apps)) delete unusable[stack];
  return { apps, unusable };
}

export const detectApps = (dir) => detectAppFolders(dir).apps;

// npm workspaces at the repository root: the Node apps then share one install and one lockfile
export const detectWorkspace = (dir) => Boolean(readJson(path.join(dir, 'package.json'))?.workspaces);

// CI files of a pipeline the repo already runs, relative paths
const PIPELINES = ['.github/workflows', '.gitlab-ci.yml', 'azure-pipelines.yml', '.woodpecker.yml', '.woodpecker', 'Jenkinsfile', 'bitbucket-pipelines.yml', '.circleci'];
// ignore: relative paths kette wrote itself, so its own ci.yml and deploy.yml never count as a pipeline of the repo
export function detectPipeline(dir, ignore = new Set()) {
  const own = (f) => !ignore.has(f.split(path.sep).join('/'));
  return PIPELINES.filter((f) => exists(dir, f) && (fs.statSync(path.join(dir, f)).isDirectory() ? listFiles(path.join(dir, f), 3).map((x) => path.relative(dir, x)).some(own) : own(f)));
}

// Detects the platform from CI and infrastructure files
export function detectPlatform(dir) {
  const files = listFiles(dir, 3).map((f) => path.relative(dir, f));
  const tf = files.filter((f) => f.endsWith('.tf')).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  if (exists(dir, 'azure-pipelines.yml') || files.some((f) => f.endsWith('.bicep'))) return 'azure-devops';
  if (exists(dir, '.gitlab-ci.yml')) return 'gitlab';
  if (exists(dir, '.woodpecker.yml') || exists(dir, '.woodpecker')) return 'oss-selfhosted';
  if (/provider\s+"aws"/.test(tf) || exists(dir, 'cdk.json')) return 'aws-github';
  if (exists(dir, '.github/workflows') || files.some((f) => /(^|\/)(Dockerfile|compose\.ya?ml|docker-compose\.ya?ml)$/.test(f))) return 'github-docker';
  return null;
}
