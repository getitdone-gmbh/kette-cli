// Kopie von kette-engineering/lib/templates.mjs, scripts/release.mjs prüft Gleichheit
// Renders platform templates and checks for a project profile; what gets rendered lives as data in the bundle, this file only resolves apps, conditions and placeholders
import fs from 'node:fs';
import path from 'node:path';

const readJson = (file) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null);
const DIRECTIVE = /^\s*(?:#|\/\/|<!--)\s*kette:(if\s+(\S+)|end)\b.*$/;
const PLACEHOLDER = /\[\[([a-z]+\/?)\]\]/g;

// A condition is a comma separated list that must all hold; a term is a flag, !flag or flag|flag
function holds(condition, flags) {
  return condition.split(',').every((term) => {
    const negated = term.startsWith('!');
    const hit = term.replace(/^!/, '').split('|').some((flag) => flags.has(flag));
    return negated ? !hit : hit;
  });
}

// Keeps the lines whose kette:if blocks hold and drops the directive lines themselves
function applyDirectives(text, flags, file) {
  const open = [];
  const out = [];
  for (const line of text.split('\n')) {
    const m = line.match(DIRECTIVE);
    if (m && m[2]) open.push(holds(m[2], flags));
    else if (m) {
      if (!open.length) throw new Error(`${file}: kette:end without kette:if`);
      open.pop();
    } else if (open.every(Boolean)) out.push(line);
  }
  if (open.length) throw new Error(`${file}: kette:if without kette:end`);
  return out.join('\n');
}

function fill(text, vars, file) {
  return text.replace(PLACEHOLDER, (_, name) => {
    if (!(name in vars)) throw new Error(`${file}: unknown placeholder [[${name}]]`);
    return vars[name];
  });
}

// [[x]] is the folder, [[x/]] the prefix for paths inside it ("" for the repository root)
const folderVars = (name, dir) => ({ [name]: dir, [`${name}/`]: dir === '.' ? '' : `${dir}/` });
const applies = (flags) => (entry) => !entry.when || holds(entry.when, flags);
const insideRepo = (dir) => !path.posix.isAbsolute(dir) && !/^[A-Za-z]:/.test(dir) && !dir.split('/').includes('..');

function render(baseDir, entry, flags, vars) {
  const file = path.join(baseDir, entry.from);
  let text = applyDirectives(fs.readFileSync(file, 'utf8'), flags, entry.from);
  for (const [from, to] of Object.entries(entry.replace || {})) text = text.replaceAll(from, to);
  // Dropped blocks leave runs of blank lines behind
  const content = fill(text, vars, entry.from).replace(/\n{3,}/g, '\n\n').replace(/\n*$/, '\n');
  return { path: path.posix.normalize(fill(entry.to, vars, entry.from)), content, note: entry.note };
}

// Apps of the profile: one per role (web, api, mobile), folder from profile.apps or the schema default
function resolveApps(bundleDir, profile) {
  const stacks = readJson(path.join(bundleDir, 'profiles', 'stack', 'index.json'));
  if (!stacks) return null;
  const defaults = readJson(path.join(bundleDir, 'schema', 'profile.schema.json'))?.properties?.apps?.properties || {};
  const apps = [];
  const skipped = [];
  for (const stack of profile.stack) {
    const meta = stacks[stack];
    const dir = (profile.apps?.[stack] || defaults[stack]?.default || '').replace(/\/+$/, '') || '.';
    const taken = apps.find((app) => app.role === meta?.role);
    if (!meta) skipped.push({ stack, reason: 'unknown stack' });
    else if (taken) skipped.push({ stack, reason: `${taken.stack} already provides the ${meta.role} app, templates cover one app per role` });
    else if (!insideRepo(dir)) skipped.push({ stack, reason: `folder ${dir} is outside the repository` });
    else apps.push({ stack, role: meta.role, dir, flags: meta.flags });
  }
  return { apps, skipped };
}

// Files for the profile; null when the bundle predates profile-aware templates. workspace: npm workspaces at the repository root
export function renderTemplates(bundleDir, profile, { workspace = false } = {}) {
  const resolved = resolveApps(bundleDir, profile);
  const checks = readJson(path.join(bundleDir, 'checks', 'index.json'));
  if (!resolved || !checks) return null;
  const { apps, skipped } = resolved;
  const flags = new Set([...apps.flatMap((app) => [app.role, ...app.flags]), ...(workspace ? ['workspace'] : [])]);
  const vars = Object.assign({}, ...apps.map((app) => folderVars(app.role, app.dir)));
  const files = checks.files.filter(applies(flags)).map((entry) => render(path.join(bundleDir, 'checks'), entry, flags, vars));

  const tplDir = path.join(bundleDir, 'profiles', 'platform', profile.platform.id, 'templates');
  const platform = readJson(path.join(tplDir, 'index.json'));
  if (!platform) return { files, skipped, platform: false };
  const templated = apps.filter((app) => {
    const entry = platform.apps[app.stack];
    if (!entry || entry.skip) skipped.push({ stack: app.stack, reason: entry?.skip || `no ${profile.platform.id} template` });
    return entry && !entry.skip;
  });
  // npm ci with workspaces needs every workspace manifest in the image, not only the one being built
  const manifests = [...new Set(templated.flatMap((app) => (platform.apps[app.stack].manifests || []).map((m) => fill(m, folderVars('dir', app.dir), 'index.json'))))].sort();
  const shared = { ...vars, manifests: manifests.map((m) => `COPY ${m} ${path.posix.dirname(m)}/`).join('\n') };
  for (const app of templated) {
    for (const entry of platform.apps[app.stack].files.filter(applies(flags))) files.push(render(tplDir, entry, flags, { ...shared, ...folderVars('dir', app.dir) }));
  }
  if (templated.length) for (const entry of platform.files.filter(applies(flags))) files.push(render(tplDir, entry, flags, shared));
  return { files, skipped, platform: true };
}
