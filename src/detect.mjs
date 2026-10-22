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
  return stacks;
}

const manifests = (dir) => [
  ...listFiles(dir, 3).filter((f) => path.basename(f) === 'package.json'),
  ...listFiles(dir, 2).filter((f) => /(pyproject\.toml|requirements\.txt)$/.test(f)),
];

// Detects stacks from the package files in the repo and in apps/*, packages/*
export function detectStack(dir) {
  return [...new Set(manifests(dir).flatMap(stacksOf))];
}

// App folder per stack, relative with / (e.g. backend, frontend, apps/web); the least nested manifest wins, the root of an npm workspace never counts
export function detectApps(dir) {
  const depth = (rel) => (rel === '.' ? 0 : rel.split('/').length);
  const found = manifests(dir)
    .map((f) => ({ f, rel: path.relative(dir, path.dirname(f)).split(path.sep).join('/') || '.' }))
    .filter(({ f, rel }) => !(rel === '.' && readJson(f)?.workspaces))
    .sort((a, b) => depth(a.rel) - depth(b.rel) || a.rel.localeCompare(b.rel));
  const apps = {};
  for (const { f, rel } of found) for (const stack of stacksOf(f)) apps[stack] ??= rel;
  return apps;
}

// npm workspaces at the repository root: the Node apps then share one install and one lockfile
export const detectWorkspace = (dir) => Boolean(readJson(path.join(dir, 'package.json'))?.workspaces);

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
