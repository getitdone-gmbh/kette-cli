import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fetchManifest, installBundle, installedBundle, readState, setActiveBundle } from './manifest.mjs';
import { detectAppFolders, detectPlatform, detectStack, detectWorkspace } from './detect.mjs';
import { validate } from './validate.mjs';
import { describe, print, apply } from './plan.mjs';
import { renderTemplates, TemplateError } from './templates.mjs';
import { ask, choose, confirm, close } from './prompt.mjs';
import { MARKETPLACE, REPAIR_NOTE, editionHints, hasClaude, installEdition, installedPlugins, pluginId, pluginInstalled, pluginsOutdated } from './claude.mjs';
import { activeBundleLink, credentialsFile, delivery, home, mirror } from './paths.mjs';
import { COMMUNITY, ENTERPRISE, editionLabel, isLegacyTier, normalizeProfile, normalizeTier, pluginDetails, pluginsFor, pluginSummary, retiredPlugins } from './editions.mjs';
import { NOTE_PATH, agentNote, renewNote } from './note.mjs';
import { rules, tilde } from './rules.mjs';
import { cliHint, cliUpgradeHint, credentialsStatus, formatDate, loginState, login, logout, tierOf, updateEnterprise } from './enterprise.mjs';
import { SCOPE } from './npmrc.mjs';
import { ciToken, figma, npmChecks, npmGranted, scopeLine } from './npm-access.mjs';
import { accent, bold, brandLine, cmd, configure, dim, error, file, num, status, symbols } from './out.mjs';
import { othersCanRead, privateHint } from './files.mjs';
import { ExitError } from './errors.mjs';
import { cloud, doctorLine } from './cloud.mjs';
import { theme } from './theme/command.mjs';

const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const STACKS = [
  { value: 'nextjs-ts-tailwind', label: 'Next.js + TypeScript + Tailwind (Web)' },
  { value: 'nestjs-prisma', label: 'NestJS + Prisma (backend, relational data)' },
  { value: 'nestjs-mongoose', label: 'NestJS + Mongoose (backend, documents)' },
  { value: 'python-fastapi', label: 'Python + FastAPI' },
  { value: 'react-native-expo', label: 'React Native + Expo (mobile)' },
  { value: 'react-spa', label: 'React + Vite (single page app)' },
];
const PLATFORMS = [
  { value: 'github-docker', label: 'GitHub + Docker on your own server' },
  { value: 'aws-github', label: 'AWS + GitHub' },
  { value: 'azure-devops', label: 'Azure + Azure DevOps' },
  { value: 'gitlab', label: 'GitLab' },
  { value: 'oss-selfhosted', label: 'Open source on your own servers' },
];
// Also the preselected answer of the platform question
const DEFAULT_PLATFORM = PLATFORMS[0].value;
// Also the preselected answer (1,2) of the stack question
const DEFAULT_STACK = STACKS.slice(0, 2).map((s) => s.value);
const PATTERNS = [
  { value: 'modular-monolith', label: 'Modular monolith (default)' },
  { value: 'layered', label: 'Layered' },
  { value: 'hexagonal', label: 'Ports and adapters' },
  { value: 'event-driven', label: 'Event-driven with outbox' },
  { value: 'cqrs', label: 'CQRS' },
  { value: 'bff', label: 'Backend for Frontend' },
  { value: 'multi-tenant', label: 'Multi-tenancy' },
];

const HELP = `Set up the rules and agents of Die Kette.

Commands:
  kette init [folder]   Create a new project with profile, rules and agents
  kette add             Connect an existing repo (detects stack and platform)
  kette doctor          Check the project and setup (--ci for pipelines)
  kette update          Load the latest rulebook
  kette rules [topic]   Show installed rules, with a topic read that rule (--path for file paths)
  kette profile         Show the project profile
  kette login [key]     Unlock Enterprise (Die Kette): agents, gates, platform profiles, checks
                        Without key: from KETTE_LICENSE_KEY, otherwise a hidden prompt
  kette logout          Remove license key, Enterprise bundle and npm access from this machine
  kette token ci create <name> | list | revoke <id>
                        CI tokens for npm ci in pipelines (Solo 2, Team 5, no device seat)
  kette figma           Download the current Figma release of Die Kette (--out folder)
  kette cloud setup     Live deploy to itdone.cloud: account link and the itdone MCP server in Claude Code
                        (--have-account skips the link, --dcr skips the fixed sign-in client, --dry-run changes nothing)
  kette cloud status    Show whether the itdone MCP server is registered and how it signs in
  kette theme           Generate a theme.css for the Community components from your brand colour (light and dark, WCAG AA)
                        Questions in a terminal, otherwise --primary <hex> [--accent <hex>] [--neutral warm|cool|neutral|<hex>]
                        [--radius none|sm|md|lg|full|<px>] [--font "<family>"] [--name <id>] [--out <path>] [--preview] [--json]
  kette version

Options:
  --dry-run             Show the plan, write nothing
  --yes                 No questions, use defaults or the values from the options
  --stack a,b           Set stacks
  --platform id         Set platform
  --patterns a,b        Set patterns
  --no-plugins          Do not install Claude Code plugins
  --path                With kette rules, show file paths instead of content
  --no-npm              With kette login and update, do not set up npm access
  --npm-replace         Comment out an existing @getitdone-gmbh line in ~/.npmrc and use Die Kette
  --out folder          Target folder for kette figma; with kette theme the CSS file (default ./theme.css)
  --primary hex         With kette theme, the brand colour (required without a terminal)
  --accent hex          With kette theme, an accent for accent surfaces (default: neutral)
  --neutral kind        With kette theme, warm, cool (default), neutral or a hex colour to tint the greys
  --radius size         With kette theme, none, sm, md (default), lg, full or pixels
  --font family         With kette theme, the font family (default Inter)
  --name id             With kette init the project name, with kette theme the theme name
  --preview             With kette theme, also write theme-preview.html and open it in a terminal
  --json                With kette theme, print the tokens and the contrast report as JSON
  --have-account        With kette cloud setup, do not open the itdone.cloud registration
  --dcr                 With kette cloud setup, sign in through dynamic client registration instead of the fixed client
  --color, --no-color   Force colors on or off (default: on in a terminal, off in pipes, CI and with NO_COLOR)

kette theme writes a drop-in replacement for the Community theme.css. Enterprise extends the token source in kette-tokens instead.
The installer never creates cloud resources and never deploys. Infrastructure is written as code in the repo.
kette cloud setup only registers the itdone MCP server; Claude Code deploys after you confirm, and kette never handles a password or token.`;

// Brand line with version and edition, only on init and help
const brand = () => brandLine(`kette ${VERSION} ${symbols().sep} ${editionLabel(tierOf())}`);
// Commands and options in the accent color; padding stays plain so the columns line up
const help = () => [brand(), '', HELP.replace(/^ {2}((?:kette|--)\S*(?: \S+)*?)(?= {2,}|$)/gm, (_, usage) => `  ${cmd(usage)}`)].join('\n');

const FLAGS = {
  '--dry-run': 'dryRun', '--yes': 'yes', '-y': 'yes', '--no-plugins': 'noPlugins', '--ci': 'ci', '--path': 'path',
  '--no-npm': 'noNpm', '--npm-replace': 'npmReplace', '--have-account': 'haveAccount', '--dcr': 'dcr', '--help': 'help', '-h': 'help', '--version': 'version',
  '--preview': 'preview', '--json': 'json',
};
const VALUES = ['--stack', '--platform', '--patterns', '--name', '--out', '--primary', '--accent', '--neutral', '--radius', '--font'];

// Unknown options and options without their value stop with exit code 2, so a typo never runs with defaults
export function parse(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (Object.hasOwn(FLAGS, a)) opts[FLAGS[a]] = true;
    else if (a === '--color' || a === '--no-color') opts.color = a === '--color';
    else if (VALUES.includes(a)) {
      const value = argv[++i];
      if (value === undefined || value.startsWith('-')) throw new ExitError(`${a} needs a value`);
      opts[a.slice(2)] = value;
    } else if (a.startsWith('-') && a !== '-') throw new ExitError(`Unknown option ${a}`);
    else opts._.push(a);
  }
  return opts;
}

const listArg = (s) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : null);

async function ensureBundle(tier) {
  const have = installedBundle(tier);
  if (have) return have.dir;
  console.log(`Loading rulebook (${editionLabel(tier)}) from ${mirror()} ...`);
  return installBundle(await fetchManifest(), tier);
}

function loadSchema(bundleDir) {
  return JSON.parse(fs.readFileSync(path.join(bundleDir, 'schema', 'profile.schema.json'), 'utf8'));
}

async function buildProfile(root, opts, detected) {
  const name = opts.name || path.basename(path.resolve(root));
  let stack = listArg(opts.stack) || detected.stack;
  let platform = opts.platform || detected.platform;
  let patterns = listArg(opts.patterns);
  if (!opts.yes) {
    if (!listArg(opts.stack)) {
      const def = (stack.length ? stack : DEFAULT_STACK).map((s) => STACKS.findIndex((x) => x.value === s) + 1).join(',');
      stack = await choose('Which stacks does the project use?', STACKS, def);
    }
    if (!opts.platform) {
      const def = String((PLATFORMS.findIndex((x) => x.value === platform) + 1) || 1);
      [platform] = await choose('Where is it built and run?', PLATFORMS, def);
    }
    if (!patterns) patterns = await choose('Which architecture patterns? (if unsure, 1)', PATTERNS, '1');
  }
  return {
    $schema: 'https://kette.itdone.de/schema/profile.schema.json',
    version: 1,
    project: { name },
    stack: stack.length ? stack : DEFAULT_STACK,
    platform: { id: platform || DEFAULT_PLATFORM },
    patterns: patterns?.length ? patterns : ['modular-monolith'],
    tier: tierOf(),
  };
}

// .kette/README.md as a marked block, so init, add and update renew only that part; tier is the project edition
function noteItem(tier) {
  const note = agentNote(tier);
  return { path: NOTE_PATH, mode: 'renew', content: note, renew: (current) => renewNote(current, note) };
}

const RANK = { [COMMUNITY]: 0, [ENTERPRISE]: 1 };

// Profile in the project, null when missing or unreadable (the file then stays as it is)
function existingProfile(root) {
  try { return normalizeProfile(readProfile(root)); } catch { return null; }
}

// Project edition after init or add: from the profile, raised to the edition of this machine, never lowered (docs/adr/0001)
function projectTier(root, machineTier) {
  const tier = existingProfile(root)?.tier;
  return Object.hasOwn(RANK, tier) && RANK[tier] >= RANK[machineTier] ? tier : machineTier;
}

// Existing profile: only raise tier and add apps when the field is missing, every other field stays as the user wrote it
function renewProfile(current, tier, apps) {
  let profile;
  try { profile = JSON.parse(current); } catch { return current; }
  const raise = RANK[normalizeTier(profile.tier)] < RANK[tier];
  const addApps = apps && Object.keys(apps).length && !('apps' in profile);
  if (!raise && !addApps) return current;
  const next = raise ? { ...profile, tier } : profile;
  return JSON.stringify(addApps ? insertAfter(next, 'stack', 'apps', apps) : next, null, 2) + '\n';
}

// New key right after an existing one, so the file keeps its reading order; at the end when that key is missing
function insertAfter(obj, after, key, value) {
  if (!(after in obj)) return { ...obj, [key]: value };
  return Object.fromEntries(Object.entries(obj).flatMap((entry) => (entry[0] === after ? [entry, [key, value]] : [entry])));
}

// App folders in the profile only when the installed schema knows the field, older bundles reject unknown fields; folders already in the profile stay
// unusable: stacks whose detected folder the profile cannot hold, they get no entry (no default either, it would point to a folder that is not there)
// Only folders the schema accepts are added, so kette never writes an invalid apps entry into a profile
function withApps(profile, schema, detected, unusable = {}) {
  const known = schema.properties?.apps?.properties;
  if (!known) return profile;
  const accepted = (s, dir) => dir && (!known[s].pattern || new RegExp(known[s].pattern).test(dir));
  const apps = Object.fromEntries((profile.stack || []).filter((s) => known[s] && !(s in unusable)).map((s) => [s, detected[s] || known[s].default]).filter(([s, dir]) => accepted(s, dir)));
  const merged = { ...apps, ...profile.apps };
  return 'apps' in profile ? { ...profile, apps: merged } : insertAfter(profile, 'stack', 'apps', merged);
}

// New projects get the English ADR template; a project with the German one from CLI 0.5 gets no second one; older bundles only ship the German file
function adrItem(root, bundleDir) {
  const dir = path.join(bundleDir, 'rules', 'architecture');
  const english = path.join(dir, 'adr-template.md');
  if (!fs.existsSync(english)) return { path: 'docs/adr/0000-vorlage.md', content: fs.readFileSync(path.join(dir, 'adr-vorlage.md'), 'utf8') };
  if (fs.existsSync(path.join(root, 'docs', 'adr', '0000-vorlage.md'))) return null;
  return { path: 'docs/adr/0000-template.md', content: fs.readFileSync(english, 'utf8') };
}

function planFor(root, profile, bundleDir, tier, noteTier, templates, apps) {
  const plan = [
    { path: '.kette/profile.json', mode: 'renew', content: JSON.stringify(profile, null, 2) + '\n', renew: (current) => renewProfile(current, noteTier, apps) },
    noteItem(noteTier),
    { path: 'CLAUDE.md', mode: 'append', marker: '@.kette/README.md', content: '@.kette/README.md\n', note: 'points to the Die Kette rules' },
    adrItem(root, bundleDir),
  ].filter(Boolean);
  if (tier === ENTERPRISE) {
    // Only the scope line, never a token: the file may be committed, the token comes from ~/.npmrc or the CI secret
    // No line without npm access, otherwise the project points to a registry that does not answer yet
    if (npmGranted()) plan.push({ path: '.npmrc', mode: 'append', marker: `${SCOPE}:registry=`, content: scopeLine(), note: 'design system packages via Die Kette, no token' });
    for (const f of templates?.files || []) plan.push({ path: f.path, content: f.content, note: f.note });
  }
  return plan;
}

// Shipped bundles render with their own lib/templates.mjs, so a TemplateError means the bundle is newer than this CLI
function templatesFor(bundleDir, profile, workspace) {
  try {
    return { templates: renderTemplates(bundleDir, profile, { workspace }) };
  } catch (err) {
    if (!(err instanceof TemplateError)) throw err;
    return { newer: err.message };
  }
}

// A new monorepo: the templates assume npm workspaces, so init adds the root package.json they need; never on add, never over an existing file
function workspaceManifest(bundleDir, profile, templates) {
  const f = path.join(bundleDir, 'profiles', 'stack', 'index.json');
  const stacks = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
  const apps = Object.entries(profile.apps || {}).filter(([stack]) => stacks[stack]?.flags?.includes('node')).map(([, dir]) => dir);
  const isManifest = (p) => p !== 'package.json' && path.posix.basename(p) === 'package.json';
  const tools = templates.files.filter((t) => isManifest(t.path)).map((t) => path.posix.dirname(t.path));
  const workspaces = [...new Set([...apps, ...tools])];
  if (!workspaces.length) return null;
  return {
    item: { path: 'package.json', content: JSON.stringify({ private: true, workspaces }, null, 2) + '\n', note: 'npm workspaces for the apps' },
    templates: { ...templates, files: templates.files.map((t) => (isManifest(t.path) ? { ...t, note: 'template, listed in the root workspaces' } : t)) },
  };
}

function platformStatus(bundleDir, id) {
  const f = path.join(bundleDir, 'profiles', 'platform', 'index.json');
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, 'utf8')).find((p) => p.id === id)?.status || null;
}

// Why platform templates are missing (Enterprise only); Community gets its Enterprise hint once, as the last next step
function templateHint(rendered, templates, target, bundleDir) {
  if (rendered.invalid) return `.kette/profile.json is not valid (${rendered.invalid}), platform templates and checks are skipped. Fix the profile, then run ${cmd('kette add')} again.`;
  if (rendered.newer) return `The installed rulebook is newer than this CLI understands (${rendered.newer}), platform templates and checks are skipped. ${cliUpgradeHint()}`;
  if (!templates) return `The installed rulebook has no profile-aware templates yet, load the current one with: ${cmd('kette update')}`;
  if (!templates.platform) return `No templates for ${target.platform.id} yet (status: ${platformStatus(bundleDir, target.platform.id) || 'unknown'}).`;
  return null;
}

const unusableFolder = (dir, stack) => `Folder "${dir}" (${stack}) can't be used as an app folder. Rename it (letters, digits, . _ - only) or point apps to another folder in .kette/profile.json.`;

// One part of the Detected line: a flag wins over detection, without either the profile gets the default
function detectedNote(kind, detected, given, fallback) {
  if (given && detected && given !== detected) return `using ${kind} ${given} (detected ${detected})`;
  if (detected) return `${kind} ${detected}`;
  return `no ${kind}${given || fallback ? `, using ${given || fallback}` : ''}`;
}

// Interactive runs still ask, so they only get the default named when nothing else decides
function detectedLine(detected, opts) {
  const fallback = (value) => (opts.yes ? value : null);
  const stack = detectedNote('stack', detected.stack.join(', '), listArg(opts.stack)?.join(', '), fallback(DEFAULT_STACK.join(', ')));
  const platform = detectedNote('platform', detected.platform, opts.platform, fallback(DEFAULT_PLATFORM));
  const defaulted = opts.yes ? [!detected.stack.length && !opts.stack && '--stack', !detected.platform && !opts.platform && '--platform'].filter(Boolean) : [];
  return `Detected: ${stack} · ${platform}${defaulted.length ? ` (change with ${defaulted.join(' / ')})` : ''}`;
}

// Detected stacks the bundle schema does not list yet (an older rulebook) stay out, so detection never makes an invalid profile
function detectFor(root, isNew, schema) {
  if (isNew) return { folders: { apps: {}, unusable: {} }, detected: { stack: [], platform: null, apps: {} }, unknown: [] };
  const known = schema.properties?.stack?.items?.enum;
  const keep = (stack) => !known || known.includes(stack);
  const pick = (map) => Object.fromEntries(Object.entries(map).filter(([stack]) => keep(stack)));
  const found = detectAppFolders(root);
  const stacks = detectStack(root);
  const folders = { apps: pick(found.apps), unusable: pick(found.unusable) };
  return { folders, detected: { stack: stacks.filter(keep), platform: detectPlatform(root), apps: folders.apps }, unknown: stacks.filter((s) => !keep(s)) };
}

async function setup(root, opts, isNew) {
  const tier = tierOf();
  const bundleDir = await ensureBundle(tier);
  if (isNew) fs.mkdirSync(root, { recursive: true });
  const schema = loadSchema(bundleDir);
  const { folders, detected, unknown } = detectFor(root, isNew, schema);
  if (!isNew) console.log(detectedLine(detected, opts));
  if (unknown.length) console.log(`${status('warn', 'WARN')} The installed rulebook does not know ${unknown.join(', ')} yet, left out of the profile. Load the current one with: ${cmd('kette update')}`);
  if (Object.keys(detected.apps).length) console.log(`App folders: ${Object.entries(detected.apps).map(([stack, dir]) => `${stack} ${dir}`).join(', ')}`);
  // apps only matters where templates are rendered, so Community stays quiet
  if (tier === ENTERPRISE) for (const [stack, dir] of Object.entries(folders.unusable)) console.log(`${status('warn', 'WARN')} ${unusableFolder(dir, stack)}`);
  // apps says where the templates go, so only Enterprise writes it; a Community project gets it from detection when it is upgraded
  const appsSchema = tier === ENTERPRISE ? schema : {};
  const profile = withApps(await buildProfile(root, opts, detected), appsSchema, detected.apps, folders.unusable);
  const errors = validate(schema, profile);
  if (errors.length) throw new Error(`Invalid profile: ${errors.join('; ')}`);

  // Templates follow the profile in the project if there is one, it is never replaced
  const current = existingProfile(root);
  const target = current ? withApps(current, appsSchema, detected.apps, folders.unusable) : profile;
  // The profile in the project steers paths, so it is checked against the schema before anything is rendered from it
  const invalid = current ? validate(schema, target) : [];
  // A stack found only in an unusable folder and without an apps entry renders nothing, the default folder would not be its folder
  const skippedStacks = (target.stack || []).filter((s) => s in folders.unusable && !target.apps?.[s]);
  const renderable = { ...target, stack: (target.stack || []).filter((s) => !skippedStacks.includes(s)) };
  const rendered = tier !== ENTERPRISE ? {} : invalid.length ? { invalid: invalid.join('; ') } : templatesFor(bundleDir, renderable, isNew || detectWorkspace(root));
  if (rendered.templates) rendered.templates.skipped.push(...skippedStacks.map((stack) => ({ stack, reason: `folder "${folders.unusable[stack]}" can't be used as an app folder, see the warning above` })));
  const workspace = isNew && rendered.templates ? workspaceManifest(bundleDir, target, rendered.templates) : null;
  const templates = workspace?.templates || rendered.templates || null;
  const plan = planFor(root, profile, bundleDir, tier, projectTier(root, tier), templates, target.apps);
  const described = describe(workspace ? [...plan, workspace.item] : plan, root);
  console.log(`\n${opts.dryRun ? 'Would create' : 'Plan'} in ${file(path.resolve(root))} (edition ${editionLabel(tier)}):`);
  print(described);
  const stale = staleNote(described);
  if (stale) console.log(stale);
  const missing = tier === ENTERPRISE ? templateHint(rendered, templates, target, bundleDir) : null;
  if (missing) console.log(`\n  ${missing}`);
  for (const s of templates?.skipped || []) console.log(`  No templates for ${s.stack}: ${s.reason}`);
  if (opts.dryRun) return 0;
  if (!(await confirm('\nCreate these files?', opts.yes))) { console.log('Cancelled, nothing written.'); return 1; }

  if (isNew && !fs.existsSync(path.join(root, '.git'))) spawnSync('git', ['init', '-q', root]);
  apply(described, root);

  let plugins = { ok: false, reason: 'skipped with --no-plugins' };
  let rulesDir = bundleDir;
  if (!opts.noPlugins) {
    rulesDir = setActiveBundle(bundleDir);
    plugins = installEdition(rulesDir, tier, otherEditionPlugins(tier));
    for (const l of editionHints(plugins, rulesDir)) console.log(l);
  }
  console.log(summary(described, tier, plugins.ok, rulesDir, root));
  return 0;
}

const otherEditionPlugins = (tier) => retiredPlugins(tier === ENTERPRISE ? COMMUNITY : ENTERPRISE, tier);

// Hint when an existing .kette/README.md has no kette block; the file is then left alone
function staleNote(described) {
  if (!described.find((d) => d.path === NOTE_PATH)?.unmarked) return null;
  return `  ${file(NOTE_PATH)} has no kette block and stays unchanged. To regenerate it, save your own notes, delete the file and run ${cmd('kette add')} again.`;
}

// Shell-safe cd into the project when it is not the current folder, as the first next step
function cdStep(root) {
  if (path.resolve(root) === process.cwd()) return [];
  return [cmd(`cd ${/^[\w./~-]+$/.test(root) ? root : `"${root}"`}`)];
}

// Short wrap-up: what was created in the project, what is active on this machine, what comes next
function summary(described, tier, pluginsOk, rulesDir, root) {
  const label = { append: ' (appended)', update: ' (updated)' };
  const changed = described.filter((d) => d.action !== 'keep').map((d) => `${file(d.path)}${label[d.action] || ''}`);
  const steps = [...cdStep(root), cmd('kette doctor'), 'Open Claude Code in the project and ask: "Check this code against the Die Kette rules"'];
  if (tier === ENTERPRISE) steps.push(`A whole feature with all roles and gates: ${cmd('/feature-loop start <feature>')}`);
  const numbered = steps.map((s, i) => `  ${num(`${i + 1}.`)} ${s}`);
  // The only Enterprise hint for Community, dimmed as the last step
  if (tier === COMMUNITY) numbered.push(dim(`  ${steps.length + 1}. kette login <key> for agents, gates, profiles and checks (Enterprise)`));
  const plugins = pluginSummary(tier, MARKETPLACE, rulesDir);
  return [
    '',
    `${bold(accent('Done.'))} In the project: ${changed.length ? changed.join(', ') : 'nothing changed, everything already in place'}`,
    pluginsOk ? `${bold('Active in Claude Code:')} ${plugins}` : `${bold('Not active in Claude Code yet')} ${dim(`(plugins: ${plugins})`)}`,
    `${bold('Rulebook on this machine:')} ${file(tilde(rulesDir))}${dim(', browse with:')} ${cmd('kette rules')}`,
    bold('Next steps:'),
    ...numbered,
  ].join('\n');
}

function readProfile(root) {
  const f = path.join(root, '.kette', 'profile.json');
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

function tool(bin, args = ['--version']) {
  const r = spawnSync(bin, args, { encoding: 'utf8' });
  return r.status === 0 ? (r.stdout || r.stderr).trim().split('\n')[0] : null;
}

async function doctor(root, opts) {
  let problems = 0;
  // failMsg states the actual condition when the check fails, msg when it holds
  const line = (ok, msg, failMsg = msg) => { console.log(`${ok ? status('ok', 'OK  ') : status('fail', 'FAIL')} ${ok ? msg : failMsg}`); if (!ok) problems++; };
  let warnings = 0;
  const warn = (msg) => { console.log(`${status('warn', 'WARN')} ${msg}`); warnings++; };
  const info = (msg) => console.log(`${status('info', 'INFO')} ${msg}`);
  line(Number(process.versions.node.split('.')[0]) >= 20, `Node ${process.versions.node} ${dim('(20 or newer)')}`, `Node ${process.versions.node} is too old, 20 or newer is required`);
  line(Boolean(tool('git')), 'git found', 'git not found');
  if (!opts.ci) {
    const claude = hasClaude();
    if (claude) line(true, 'Claude Code found');
    else warn('Claude Code not found, agents and plugins need it');
  }
  const tier = tierOf();
  const bundle = installedBundle(tier);
  edition(tier, { line, warn });
  line(Boolean(bundle), `Rulebook installed ${dim(`(${editionLabel(tier)}${bundle ? `, version ${bundle.version}` : ''})`)}`, `Rulebook not installed (${editionLabel(tier)}). Load it with: ${cmd('kette update')}`);
  if (bundle) info(`Rulebook and plugins live in ${file(tilde(fs.existsSync(activeBundleLink()) ? activeBundleLink() : bundle.dir))}`);
  const raw = readProfile(root);
  const profile = normalizeProfile(raw);
  // Outside a project only --ci counts a missing profile, a person just gets told where to go
  if (profile || opts.ci) line(Boolean(profile), '.kette/profile.json present', '.kette/profile.json missing');
  else info(`No kette project in this folder. cd into your project or run ${cmd('kette init')}.`);
  if (raw && isLegacyTier(raw.tier)) warn(`Profile uses the old value tier "${raw.tier}", read as "${profile.tier}". Change it to "${profile.tier}" in .kette/profile.json.`);
  if (profile && bundle) {
    const schema = loadSchema(bundle.dir);
    const errs = validate(schema, profile);
    // A profile written by a newer CLI may name app folders the installed rulebook does not know yet: that needs an update, not a fix
    if (errs.length === 1 && errs[0] === '$: unknown field apps' && !schema.properties?.apps) warn(`The profile names app folders (apps), the installed rulebook does not know them yet. Load the current one with: ${cmd('kette update')}`);
    else line(errs.length === 0, 'Profile valid', `Profile not valid: ${errs.join('; ')}`);
    if (PREVIEW.includes(platformStatus(bundle.dir, profile.platform?.id))) warn(`Platform ${profile.platform.id} is still a preview ${dim('(no verified reference project)')}`);
    if (profile.tier === ENTERPRISE && tier !== ENTERPRISE) warn(`Profile requires the Enterprise edition (Die Kette), only Community is installed here. Agents, gates, /feature-loop, platform profiles and checks from .kette/README.md are missing. Unlock with: ${cmd('kette login <key>')}`);
    if (profile.tier !== ENTERPRISE && tier === ENTERPRISE) warn(`Enterprise (Die Kette) is installed here, the project is on Community. Switch to the flow with agents and gates: ${cmd('kette add')}`);
    for (const o of profile.overlays || []) warn(`Overlay ${o.source} is loaded by the agents, not checked here`);
  }
  if (!opts.ci && bundle && hasClaude()) {
    const list = installedPlugins();
    if (list === null) line(false, 'Claude Code plugin list not readable (claude plugin list fails)');
    else for (const p of pluginsFor(tier)) line(pluginInstalled(p, list), `Plugin ${pluginId(p)} installed`, `Plugin ${pluginId(p)} not installed. Install with: ${cmd('kette update')}`);
  }
  if (!opts.ci && bundle) printPluginDetails(tier, bundle.dir, info);
  if (!opts.ci && hasClaude()) doctorLine(line, info);
  if (tier === ENTERPRISE) await npmChecks(root, { line, warn }, opts);
  const md = path.join(root, 'CLAUDE.md');
  if (profile) line(fs.existsSync(md) && fs.readFileSync(md, 'utf8').includes('@.kette/README.md'), 'CLAUDE.md points to the Die Kette rules', `CLAUDE.md does not point to the Die Kette rules (line @.kette/README.md missing), add it with: ${cmd('kette add')}`);
  // Warnings never fail doctor, but the closing line counts them so "all good" does not hide them
  const warned = warnings ? `, ${warnings} warning${warnings === 1 ? '' : 's'}` : '';
  console.log(`\n${problems ? bold(error(`${problems} open issue(s)${warned}`)) : bold(accent(`all good${warned}`))}`);
  return problems ? 1 : 0;
}

// Platform status from the bundle index; older bundles use the German word
const PREVIEW = ['preview', 'vorschau'];

// What each plugin of the edition brings, counted from the installed bundle
function printPluginDetails(tier, bundleDir, info) {
  info('Plugin contents:');
  const { tee, end, bar } = symbols();
  const details = pluginDetails(tier, MARKETPLACE, bundleDir);
  details.forEach(({ id, lines }, i) => {
    const last = i === details.length - 1;
    console.log(`      ${dim(last ? end : tee)} ${id}`);
    for (const l of lines) console.log(`      ${dim(last ? ' '.repeat(bar.length) : bar)}   ${dim(l)}`);
  });
}

// Renews the kette block in .kette/README.md when kette update runs inside a project
function renewProjectNote(root) {
  const profile = existingProfile(root);
  if (!profile) return;
  const tier = Object.hasOwn(RANK, profile.tier) ? profile.tier : COMMUNITY;
  const [d] = describe([noteItem(tier)], root);
  if (d.unmarked) { console.log(staleNote([d])); return; }
  if (d.action === 'keep') return;
  apply([d], root);
  console.log(`${file(NOTE_PATH)} ${d.action === 'create' ? 'created' : 'updated'} (flow for ${editionLabel(tier)}).`);
}

async function update(opts) {
  const code = await updateBundle(opts);
  if (code === 0 && !opts.dryRun) renewProjectNote('.');
  return code;
}

function refreshPlugins(dir, tier) {
  const link = setActiveBundle(dir);
  for (const l of editionHints(installEdition(link, tier, otherEditionPlugins(tier)), link)) console.log(l);
}

async function updateBundle(opts) {
  if (credentialsStatus() === 'valid') return updateEnterprise(opts, VERSION);
  const manifest = await fetchManifest();
  const tier = COMMUNITY;
  const have = installedBundle(tier);
  if (have?.version === manifest.version) {
    console.log(`Up to date (version ${manifest.version}).`);
    if (!opts.dryRun && !opts.noPlugins && hasClaude() && pluginsOutdated(have.dir, tier)) {
      console.log(REPAIR_NOTE);
      refreshPlugins(have.dir, tier);
    }
    return 0;
  }
  console.log(`New version ${manifest.version}${have ? ` (installed: ${have.version})` : ''}.`);
  if (manifest.changelog) console.log(manifest.changelog);
  if (opts.dryRun) return 0;
  const dir = await installBundle(manifest, tier);
  if (!opts.noPlugins) refreshPlugins(dir, tier);
  await cliHint(VERSION, manifest);
  console.log(`Rulebook ${manifest.version} installed.`);
  return 0;
}

// Edition without network, from credentials and the saved login state, so doctor --ci stays offline
function edition(tier, { line, warn }) {
  const creds = credentialsStatus();
  if (creds === 'broken') line(false, `Credentials in ${file(credentialsFile())} are damaged. Sign in again: ${cmd('kette logout && kette login <key>')}`);
  if (tier === COMMUNITY) {
    if (creds === 'valid') line(false, `License stored, but the Enterprise bundle is missing. Load it with: ${cmd('kette update')}`);
    else line(true, `Edition ${editionLabel(COMMUNITY)}`);
    return;
  }
  const state = loginState() || {};
  line(true, `Edition ${editionLabel(ENTERPRISE)}, version ${installedBundle(ENTERPRISE).version}, updates until ${formatDate(state.updates_until)}`);
  if (state.updates_until && new Date(state.updates_until) < new Date()) warn(`Update period ended on ${formatDate(state.updates_until)}. The installed version keeps working, new versions come with a renewal.`);
  if (othersCanRead(credentialsFile())) warn(privateHint(credentialsFile(), cmd));
}

// kette state shows whether a licence email is stored, never the address
function redactedState() {
  const state = readState();
  return state.login?.email ? { ...state, login: { ...state.login, email: '(stored)' } } : state;
}

export async function main(argv) {
  let opts;
  try {
    opts = parse(argv);
  } catch (err) {
    if (!(err instanceof ExitError)) throw err;
    configure();
    console.error(`kette: ${err.message}\n`);
    console.log(help());
    return err.exitCode;
  }
  configure({ color: opts.color, ci: opts.ci });
  const [command, arg] = opts._;
  try {
    if (opts.version || command === 'version') { console.log(VERSION); return 0; }
    if (!command || opts.help || command === 'help') { console.log(help()); return 0; }
    if (command === 'init') {
      const root = arg || (opts.yes ? '.' : await ask('Folder for the new project', '.'));
      if (fs.existsSync(path.join(root, '.kette', 'profile.json'))) throw new Error(`${root} already has a kette profile, use kette add or kette doctor`);
      console.log(`${brand()}\n`);
      return await setup(root, opts, !fs.existsSync(root) || fs.readdirSync(root).length === 0);
    }
    if (command === 'add') return await setup('.', opts, false);
    if (command === 'doctor') return await doctor('.', opts);
    if (command === 'update') return await update(opts);
    if (command === 'rules') {
      const tier = tierOf();
      return rules(arg, opts, { bundle: installedBundle(tier), tier, stackIds: STACKS.map((x) => x.value) });
    }
    if (command === 'profile') { const p = readProfile('.'); console.log(p ? JSON.stringify(p, null, 2) : 'No .kette/profile.json in this folder.'); return p ? 0 : 1; }
    if (command === 'login') return await login(arg, opts, VERSION);
    if (command === 'logout') return await logout(opts);
    if (command === 'token') {
      const [, kind, action, value] = opts._;
      if (kind !== 'ci') throw new Error('Usage: kette token ci create <label> | list | revoke <id>');
      return await ciToken(action, value);
    }
    if (command === 'figma') return await figma(opts);
    // The licence email only prefills the signup of an active Enterprise licence
    if (command === 'cloud') return await cloud(arg, opts, { email: tierOf() === ENTERPRISE ? loginState()?.email : null });
    if (command === 'theme') return await theme(opts, { version: VERSION });
    if (command === 'state') { console.log(JSON.stringify({ home: home(), mirror: mirror(), delivery: delivery(), ...redactedState() }, null, 2)); return 0; }
    console.error(`Unknown command: ${command}\n`);
    console.log(help());
    return 1;
  } finally {
    close();
  }
}
