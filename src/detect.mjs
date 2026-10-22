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

// Detects stacks from the package files in the repo and in apps/*, packages/*
export function detectStack(dir) {
  const stacks = new Set();
  const manifests = listFiles(dir, 3).filter((f) => path.basename(f) === 'package.json');
  for (const f of manifests) {
    const p = readJson(f) || {};
    const deps = { ...p.dependencies, ...p.devDependencies };
    if (deps.next) stacks.add('nextjs-ts-tailwind');
    if (deps['@nestjs/core'] && (deps['@prisma/client'] || deps.prisma)) stacks.add('nestjs-prisma');
    else if (deps['@nestjs/core'] && (deps.mongoose || deps['@nestjs/mongoose'])) stacks.add('nestjs-mongoose');
    else if (deps['@nestjs/core']) stacks.add('nestjs-prisma');
    if (deps.expo) stacks.add('react-native-expo');
  }
  const py = listFiles(dir, 2).filter((f) => /(pyproject\.toml|requirements\.txt)$/.test(f));
  if (py.some((f) => /fastapi/i.test(fs.readFileSync(f, 'utf8')))) stacks.add('python-fastapi');
  return [...stacks];
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
