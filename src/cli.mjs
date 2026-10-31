import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fetchManifest, installBundle, installedBundle, readState, setActiveBundle } from './manifest.mjs';
import { detectAppFolders, detectPlatform, detectStack, detectWorkspace } from './detect.mjs';
import { validate } from './validate.mjs';
import { describe, print, apply } from './plan.mjs';
import { renderTemplates, TemplateError } from './templates.mjs';
import { ask, choose, confirm, close } from './prompt.mjs';
import { MARKETPLACE, hasClaude, installedPlugins, pluginId, pluginInstalled, registeredAt, removeMarketplace, repointMarketplace } from './claude.mjs';
import { LOCAL_SETTINGS_PATH, SETTINGS_PATH, enableHints, enableProjectPlugins, settingsItems, settingsStatus, userScopePlugins, writeProjectSettings } from './project-plugins.mjs';
import { marketName } from './marketplace.mjs';
import { RECORD_PATH, enterpriseLeftovers, recordTemplates, removeLeftovers } from './leftovers.mjs';
import { activeBundleLink, bundlesDir, credentialsFile, delivery, home, mirror } from './paths.mjs';
import { COMMUNITY, ENTERPRISE, editionLabel, isLegacyTier, normalizeProfile, normalizeTier, pluginContents, pluginDetails, pluginsFor, pluginSummary } from './editions.mjs';
import { NOTE_PATH, COMMUNITY_REVIEWERS, agentNote, renewNote } from './note.mjs';
import { rules, tilde } from './rules.mjs';
import { cliHint, cliUpgradeHint, credentialsStatus, formatDate, loginState, login, logout, tierOf, updateEnterprise } from './enterprise.mjs';
import { SCOPE } from './npmrc.mjs';
import { MOVE_SCOPE, ciToken, figma, globalScope, npmChecks, npmCommand, npmGranted, scopeLine } from './npm-access.mjs';
import { projectScope, readFile } from './npmrc.mjs';
import { accent, bold, brandLine, cmd, configure, dim, error, file, num, status, symbols } from './out.mjs';
import { othersCanRead, privateHint } from './files.mjs';
import { ExitError } from './errors.mjs';
import { cloud, doctorLine } from './cloud.mjs';
import { theme } from './theme/command.mjs';
import { WALLET_HELP, hasWallet, offerWallet, wallet, walletDoctor } from './wallet/command.mjs';
import { INSTANCE_HELP, askInstance, createPending, doctorInstance, instance as instanceCommand, joinInstance, prepareJoin, requireEdition } from './instance/command.mjs';
import { inherit, instanceSource, printable, readInstance } from './instance/config.mjs';
import { TICKET_HELP, offerTicketing, ticket } from './ticket/command.mjs';

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
  kette doctor          Check the project and setup (--ci for pipelines, --instance [name] for every repo of an instance)
  kette update          Load the latest rulebook
  kette rules [topic]   Show installed rules, with a topic read that rule (--path for file paths)
  kette profile         Show the project profile (--effective: with the values inherited from its instance)
  ${INSTANCE_HELP}
  kette login [key]     Unlock Enterprise (Die Kette): agents, gates, platform profiles, checks
                        Without key: from KETTE_LICENSE_KEY, otherwise a hidden prompt
  kette logout          Remove license key, Enterprise bundle and npm access from this machine
  kette token ci create <name> | list | revoke <id>
                        CI tokens for npm ci in pipelines (Solo 2, Team 5, no device seat)
  kette figma           Download the current Figma release of Die Kette (--out folder)
  kette npm move-scope  Take the @getitdone-gmbh line out of ~/.npmrc (set up before 0.10), Enterprise projects carry it themselves
  kette cloud setup     Live deploy to itdone.cloud: account link and the itdone MCP server in Claude Code
                        (--have-account skips the link, --dcr skips the fixed sign-in client, --dry-run changes nothing)
  kette cloud status    Show whether the itdone MCP server is registered and how it signs in
  kette theme           Generate a theme.css for the Community components from your brand colour (light and dark, WCAG AA)
                        Questions in a terminal, otherwise --primary <hex> [--accent <hex>] [--neutral warm|cool|neutral|<hex>]
                        [--radius none|sm|md|lg|full|<px>] [--font "<family>"] [--name <id>] [--out <path>] [--preview] [--json]
  ${WALLET_HELP}
  ${TICKET_HELP}
  kette version

Options:
  --dry-run             Show the plan, write nothing
  --yes                 No questions, use defaults or the values from the options
  --stack a,b           Set stacks
  --platform id         Set platform
  --patterns a,b        Set patterns
  --no-plugins          Do not enable Claude Code plugins for the project
  --instance [name]     With kette init and add, connect the project to this instance; with kette instance the instance meant
  --edition id          With kette instance create: enterprise or community (default: the edition of this machine)
  --from source         With kette instance create, clone an instance repo (git URL) or link a folder that has instance.json
  --role id             With kette instance members add: owner or member (default member)
  --effective           With kette profile, add the values the project inherits from its instance
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
  --provider id         With kette wallet init: infisical (default), vault, aws-secrets-manager, azure-key-vault, command
  --env name            With kette wallet, the environment (with add a comma separated list)
  --app name            With kette wallet, only the secrets of this app
  --note text           With kette wallet add, what the secret is for
  --stdin               With kette wallet set and add, read the value from stdin instead of a hidden prompt
  --github-env name     With kette wallet sync github, the GitHub environment (default: the wallet environment)
  --repo owner/name     With kette wallet sync github, another repo than the current one
  --project id          With kette ticket connect, the project on the board (workload.zero project id)
  --by member           With kette ticket new, who decided (a member of the instance)
  --as member           With kette ticket, who acts (member, session or agent); pick needs it
  --stations a,b        With kette ticket new and extend, the stations as station[:target][@artifact]
  --source ref          With kette ticket new, where it was decided (chat:<session>, meeting:<date>, note:<file>)
  --member id, --station s, --status a,b
                        With kette ticket list and inbox, filter the items
  --color, --no-color   Force colors on or off (default: on in a terminal, off in pipes, CI and with NO_COLOR)

kette theme writes a drop-in replacement for the Community theme.css. Enterprise extends the token source in kette-tokens instead.
The installer never creates cloud resources and never deploys. Infrastructure is written as code in the repo.
Plugins are enabled per project in .claude/settings.json, never for all projects; a Community project never enables Enterprise plugins.
kette wallet keeps names in .kette/wallet.json and values in your provider; it never prints a value and never takes one as an argument.
kette ticket reads its board, stations and members from the instance of the repo and its credential from the secret wallet; it writes to a board only after a yes or --yes.
kette cloud setup only registers the itdone MCP server; Claude Code deploys after you confirm, and kette never handles a password or token.`;

// Brand line with version and edition, only on init and help
const brand = () => brandLine(`kette ${VERSION} ${symbols().sep} ${editionLabel(tierOf())}`);
// Commands and options in the accent color; padding stays plain so the columns line up
const help = () => [brand(), '', HELP.replace(/^ {2}((?:kette|--)\S*(?: \S+)*?)(?= {2,}|$)/gm, (_, usage) => `  ${cmd(usage)}`)].join('\n');

const FLAGS = {
  '--dry-run': 'dryRun', '--yes': 'yes', '-y': 'yes', '--no-plugins': 'noPlugins', '--ci': 'ci', '--path': 'path',
  '--no-npm': 'noNpm', '--npm-replace': 'npmReplace', '--have-account': 'haveAccount', '--dcr': 'dcr', '--help': 'help', '-h': 'help', '--version': 'version',
  '--preview': 'preview', '--json': 'json', '--stdin': 'stdin', '--effective': 'effective', '--paraphrase': 'paraphrase',
};
const VALUES = ['--stack', '--platform', '--patterns', '--name', '--out', '--primary', '--accent', '--neutral', '--radius', '--font', '--provider', '--env', '--app', '--note', '--github-env', '--repo', '--edition', '--from', '--role',
  '--project', '--by', '--as', '--source', '--stations', '--statement', '--words', '--rationale', '--label', '--comment', '--member', '--station', '--status',
  '--pr', '--commit', '--figma', '--review', '--approved-by', '--proposed-by', '--acceptance'];
// Free text may start with a dash
const TEXT_VALUES = ['--note', '--statement', '--words', '--rationale', '--comment', '--acceptance'];

// Unknown options and options without their value stop with exit code 2, so a typo never runs with defaults
export function parse(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    // Everything after -- belongs to the command kette wallet run starts
    if (a === '--') { opts.rest = argv.slice(i + 1); break; }
    if (Object.hasOwn(FLAGS, a)) opts[FLAGS[a]] = true;
    // --instance takes a name, alone (kette doctor --instance) it means the instance of the repo in this folder
    else if (a === '--instance') opts.instance = argv[i + 1] === undefined || argv[i + 1].startsWith('-') ? true : argv[++i];
    else if (a === '--color' || a === '--no-color') opts.color = a === '--color';
    else if (VALUES.includes(a)) {
      const value = argv[++i];
      if (value === undefined || (value.startsWith('-') && !TEXT_VALUES.includes(a))) throw new ExitError(`${a} needs a value`);
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

async function buildProfile(root, opts, detected, tier, instance) {
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
    ...(instance ? { instance: instance.name } : {}),
    stack: stack.length ? stack : DEFAULT_STACK,
    platform: { id: platform || DEFAULT_PLATFORM },
    patterns: patterns?.length ? patterns : ['modular-monolith'],
    tier,
  };
}

// .kette/README.md as a marked block, so init, add and update renew only that part; tier is the project edition, flow the review flow from the profile
function noteItem(tier, flow) {
  const note = agentNote(tier, flow);
  return { path: NOTE_PATH, mode: 'renew', content: note, renew: (current) => renewNote(current, note) };
}

const RANK = { [COMMUNITY]: 0, [ENTERPRISE]: 1 };

// Profile in the project, null when missing or unreadable (the file then stays as it is)
function existingProfile(root) {
  try { return normalizeProfile(readProfile(root)); } catch { return null; }
}

// Project edition after init or add: the edition of its instance (docs/adr/0002), otherwise from the profile,
// raised to the edition of this machine, never lowered (docs/adr/0001)
function projectTier(root, machineTier, instance) {
  if (instance) return instance.edition;
  const tier = existingProfile(root)?.tier;
  return Object.hasOwn(RANK, tier) && RANK[tier] >= RANK[machineTier] ? tier : machineTier;
}

// Existing profile: only raise tier and add apps when the field is missing, every other field stays as the user wrote it;
// with an instance, tier follows the instance (also down to Community, it is a deliberate choice) and instance names it
export function renewProfile(current, tier, apps, instance = null) {
  let profile;
  try { profile = JSON.parse(current); } catch { return current; }
  const retier = instance ? profile.tier !== tier : RANK[normalizeTier(profile.tier)] < RANK[tier];
  const rename = instance && profile.instance !== instance;
  const addApps = apps && Object.keys(apps).length && !('apps' in profile);
  if (!retier && !rename && !addApps) return current;
  let next = retier ? { ...profile, tier } : profile;
  if (rename) next = 'instance' in next ? { ...next, instance } : insertAfter(next, 'project', 'instance', instance);
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

function planFor(root, profile, bundleDir, tier, noteTier, templates, apps, { instance = null, plugins = true } = {}) {
  const plan = [
    { path: '.kette/profile.json', mode: 'renew', content: JSON.stringify(profile, null, 2) + '\n', renew: (current) => renewProfile(current, noteTier, apps, instance?.name) },
    noteItem(noteTier, existingProfile(root)?.flow ?? profile.flow),
    { path: 'CLAUDE.md', mode: 'append', marker: '@.kette/README.md', content: '@.kette/README.md\n', note: 'points to the Die Kette rules' },
    adrItem(root, bundleDir),
    ...(plugins ? settingsItems(noteTier) : []),
  ].filter(Boolean);
  if (tier === ENTERPRISE) {
    // Only the scope line, never a token: the file may be committed, the token comes from ~/.npmrc or the CI secret
    // No line without npm access, otherwise the project points to a registry that does not answer yet
    if (npmGranted()) plan.push(npmrcItem());
    // template: recorded with its hash in .kette/templates.json, so a later switch to Community can remove it again
    for (const f of templates?.files || []) plan.push({ path: f.path, content: f.content, note: f.note, template: true });
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

const notFound = (name) => `Instance ${printable(name)} not found on this machine. Create it with ${cmd(`kette instance create ${printable(name)}`)} or clone it with ${cmd(`kette instance create ${printable(name)} --from <git-url>`)}`;

// The instance a project belongs to: --instance on init and add, otherwise the name in its profile; null without one
function projectInstance(root, opts = {}) {
  if (opts.instance === true) throw new ExitError('--instance needs a name with kette init and kette add');
  const name = opts.instance || existingProfile(root)?.instance;
  if (!name) return null;
  let instance;
  try { instance = readInstance(name); } catch (err) { throw new ExitError(err.message, 1); }
  if (!instance) throw new ExitError(notFound(name), 1);
  return instance;
}

// The edition every gate of a project uses (plugins, templates, npm, wallet, rules); problem names why an instance the profile names
// cannot be used: such a project counts as Community, never as the edition of the machine (docs/adr/0002, decision 10)
function resolveProject(root) {
  const profile = existingProfile(root);
  if (!profile) return { profile: null, instance: null, edition: null, problem: null };
  if (!profile.instance) return { profile, instance: null, edition: Object.hasOwn(RANK, profile.tier) ? profile.tier : COMMUNITY, problem: null };
  let instance = null;
  let problem = null;
  try { instance = readInstance(profile.instance); } catch (err) { problem = err.message; }
  if (!instance && !problem) problem = notFound(profile.instance);
  return { profile, instance, edition: instance ? instance.edition : COMMUNITY, problem };
}

// The scope line of Enterprise projects: only in the project .npmrc (the token stays global per device, D3); npmrc marks it for the record
const npmrcItem = () => ({ path: '.npmrc', mode: 'append', marker: `${SCOPE}:registry=`, content: scopeLine(), note: 'design system packages via Die Kette, no token', npmrc: true });

// Leaving Enterprise: the template files kette created unchanged and the scope line kette wrote go, changed files and foreign lines stay
function leaveEnterprise(root) {
  const { removed, kept } = removeLeftovers(root, scopeLine().trim());
  for (const r of removed) console.log(`  ${status('ok', '- remove')} ${file(r)} ${dim('(Enterprise, not part of a Community project)')}`);
  for (const k of kept) console.log(`${status('warn', 'WARN')} ${file(k)} is an Enterprise template that was changed, it stays. Delete it if the project does not need it; ${cmd('kette doctor')} lists it until then.`);
}

// Profiles name their instance; a rulebook whose schema does not know the field yet checks the profile without it
function forSchema(schema, profile) {
  if (!profile || !('instance' in profile) || schema.properties?.instance) return profile;
  const { instance: _instance, ...rest } = profile;
  return rest;
}

async function setup(root, opts, isNew) {
  // Only a project without a profile is asked, so kette add on a connected repo stays quiet; a new instance is written after the confirmation
  let instance = projectInstance(root, opts);
  let pending = null;
  if (!instance && !opts.yes && !opts.dryRun && !existingProfile(root)) {
    const answer = await askInstance(root);
    instance = answer?.instance || null;
    if (answer?.create) pending = answer.instance;
  }
  const tier = instance ? requireEdition(instance) : tierOf();
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
  const profile = withApps(await buildProfile(root, opts, detected, tier, instance), appsSchema, detected.apps, folders.unusable);
  const errors = validate(schema, forSchema(schema, profile));
  if (errors.length) throw new Error(`Invalid profile: ${errors.join('; ')}`);

  // Templates follow the profile in the project if there is one, it is never replaced
  const current = existingProfile(root);
  const target = current ? withApps(current, appsSchema, detected.apps, folders.unusable) : profile;
  // The profile in the project steers paths, so it is checked against the schema before anything is rendered from it
  const invalid = current ? validate(schema, forSchema(schema, target)) : [];
  // A stack found only in an unusable folder and without an apps entry renders nothing, the default folder would not be its folder
  const skippedStacks = (target.stack || []).filter((s) => s in folders.unusable && !target.apps?.[s]);
  const renderable = { ...target, stack: (target.stack || []).filter((s) => !skippedStacks.includes(s)) };
  const rendered = tier !== ENTERPRISE ? {} : invalid.length ? { invalid: invalid.join('; ') } : templatesFor(bundleDir, renderable, isNew || detectWorkspace(root));
  if (rendered.templates) rendered.templates.skipped.push(...skippedStacks.map((stack) => ({ stack, reason: `folder "${folders.unusable[stack]}" can't be used as an app folder, see the warning above` })));
  const workspace = isNew && rendered.templates ? workspaceManifest(bundleDir, target, rendered.templates) : null;
  const templates = workspace?.templates || rendered.templates || null;
  const noteTier = projectTier(root, tier, instance);
  // Everything that can stop the join is checked before a file of the project is written (QA-09)
  if (instance && !pending && !opts.dryRun) prepareJoin(instance.name, root);
  const plan = planFor(root, profile, bundleDir, tier, noteTier, templates, target.apps, { instance, plugins: !opts.noPlugins });
  const described = describe(workspace ? [...plan, workspace.item] : plan, root);
  console.log(`\n${opts.dryRun ? 'Would create' : 'Plan'} in ${file(path.resolve(root))} (edition ${editionLabel(tier)}${instance ? `, instance ${instance.name}` : ''}):`);
  print(described);
  const stale = staleNote(described);
  if (stale) console.log(stale);
  const missing = tier === ENTERPRISE ? templateHint(rendered, templates, target, bundleDir) : null;
  if (missing) console.log(`\n  ${missing}`);
  for (const s of templates?.skipped || []) console.log(`  No templates for ${s.stack}: ${s.reason}`);
  if (opts.dryRun) return 0;
  if (!(await confirm('\nCreate these files?', opts.yes))) { console.log('Cancelled, nothing written.'); return 1; }
  if (pending) {
    createPending(pending);
    prepareJoin(pending.name, root);
  }

  if (isNew && !fs.existsSync(path.join(root, '.git'))) spawnSync('git', ['init', '-q', root]);
  apply(described, root);
  recordTemplates(root, described);
  // Only a repo that joins a Community instance leaves Enterprise; a repo without instance keeps what it had before 0.10
  if (instance && noteTier === COMMUNITY) leaveEnterprise(root);
  if (instance) for (const l of joinInstance(instance.name, root)) console.log(l);
  let plugins = { ok: false };
  if (!opts.noPlugins) {
    plugins = enableProjectPlugins(root, noteTier, installedBundle(noteTier));
    for (const l of enableHints(plugins, noteTier)) console.log(l);
  }
  await offerWallet(root, opts, tier);
  await offerTicketing(root, opts, { resolveProject });
  console.log(summary(described, tier, plugins.ok, bundleDir, root));
  return 0;
}

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
  if (tier === ENTERPRISE && !hasWallet(root)) steps.push(`Credentials per environment in the secret wallet (Infisical by default): ${cmd('kette wallet init')}`);
  if (tier === ENTERPRISE) steps.push(`A whole feature with all roles and gates: ${cmd('/feature-loop start <feature>')}, several branches with one review at the end: ${cmd('/feature-loop <description of the round>')}`);
  const numbered = steps.map((s, i) => `  ${num(`${i + 1}.`)} ${s}`);
  // The only Enterprise hint for Community, dimmed as the last step
  if (tier === COMMUNITY) numbered.push(dim(`  ${steps.length + 1}. kette login <key> for agents, gates, profiles and checks (Enterprise)`));
  const plugins = pluginSummary(tier, marketName(tier), rulesDir);
  return [
    '',
    `${bold(accent('Done.'))} In the project: ${changed.length ? changed.join(', ') : 'nothing changed, everything already in place'}`,
    pluginsOk ? `${bold('Active in Claude Code for this project:')} ${plugins}` : `${bold('Not active in Claude Code yet')} ${dim(`(plugins: ${plugins})`)}`,
    `${bold('Rulebook on this machine:')} ${file(tilde(rulesDir))}${dim(', browse with:')} ${cmd('kette rules')}`,
    bold('Next steps:'),
    ...numbered,
  ].join('\n');
}

// kette instance use: profile names the instance and takes its edition, the note follows, the project enables only its plugins,
// the repo joins the instance and leaves every other one; everything that can stop the join is checked before a file is written
async function useInstance(root, instance, opts) {
  const edition = instance.edition;
  if (!opts.dryRun) prepareJoin(instance.name, root);
  await ensureBundle(edition);
  const profile = existingProfile(root);
  const plan = [
    { path: '.kette/profile.json', mode: 'renew', content: '', renew: (current) => renewProfile(current, edition, null, instance.name) },
    noteItem(edition, profile?.flow),
    ...(opts.noPlugins ? [] : settingsItems(edition)),
    ...(edition === ENTERPRISE && npmGranted() ? [npmrcItem()] : []),
  ];
  const described = describe(plan, root);
  console.log(`${opts.dryRun ? 'Would change' : 'Plan'} in ${file(path.resolve(root))} (instance ${instance.name}, ${editionLabel(edition)}):`);
  print(described);
  if (edition === COMMUNITY) {
    const left = enterpriseLeftovers(root);
    for (const f of left.files) console.log(`  ${dim(f.changed ? '= keep    ' : '- remove  ')}${f.path}  ${dim(f.changed ? '(Enterprise template, changed by hand)' : '(Enterprise template)')}`);
    if (left.npmrc) console.log(`  ${dim('- remove  ')}.npmrc scope line  ${dim('(Enterprise registry)')}`);
  }
  if (opts.dryRun) return 0;
  apply(described, root);
  recordTemplates(root, described);
  if (edition === COMMUNITY) leaveEnterprise(root);
  for (const l of joinInstance(instance.name, root)) console.log(l);
  // Templates follow the profile and are rendered by kette add; doctor names them until then (QA-22)
  if (edition === ENTERPRISE) console.log(`Enterprise templates for CI, Docker and checks: ${cmd('kette add')}`);
  if (!opts.noPlugins) {
    const r = enableProjectPlugins(root, edition, installedBundle(edition));
    if (r.ok && r.present.length) console.log(`Claude Code plugins enabled for this project: ${r.present.map((p) => pluginId(p, r.market)).join(', ')}`);
    for (const l of enableHints(r, edition)) console.log(l);
  }
  console.log(`${bold(accent('Done.'))} This repo now uses instance ${instance.name} (${editionLabel(edition)}). Check with: ${cmd('kette doctor')}`);
  return 0;
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

// machine: Node, git, Claude Code, edition and rulebook; project: profile, instance, plugins, npm, wallet (kette doctor --instance runs them apart)
async function doctor(root, opts, { machine = true, project = true } = {}) {
  let problems = 0;
  // failMsg states the actual condition when the check fails, msg when it holds
  const line = (ok, msg, failMsg = msg) => { console.log(`${ok ? status('ok', 'OK  ') : status('fail', 'FAIL')} ${ok ? msg : failMsg}`); if (!ok) problems++; };
  let warnings = 0;
  const warn = (msg) => { console.log(`${status('warn', 'WARN')} ${msg}`); warnings++; };
  const info = (msg) => console.log(`${status('info', 'INFO')} ${msg}`);
  const tier = tierOf();
  const bundle = installedBundle(tier);
  if (machine) {
    line(Number(process.versions.node.split('.')[0]) >= 20, `Node ${process.versions.node} ${dim('(20 or newer)')}`, `Node ${process.versions.node} is too old, 20 or newer is required`);
    line(Boolean(tool('git')), 'git found', 'git not found');
    if (!opts.ci) {
      if (hasClaude()) line(true, 'Claude Code found');
      else warn('Claude Code not found, agents and plugins need it');
    }
    edition(tier, { line, warn });
    line(Boolean(bundle), `Rulebook installed ${dim(`(${editionLabel(tier)}${bundle ? `, version ${bundle.version}` : ''})`)}`, `Rulebook not installed (${editionLabel(tier)}). Load it with: ${cmd('kette update')}`);
    if (bundle) info(`Rulebook of this machine in ${file(tilde(path.dirname(bundle.dir)))}`);
    const legacy = opts.ci ? [] : userScopePlugins();
    // Plugins of CLI versions before 0.10 stay usable; they load in every project that has no .claude/settings.json of its own
    if (legacy.length) warn(`Claude Code has Kette plugins on for all projects (user scope, set up by an older kette): ${legacy.join(', ')}. Projects now enable their own plugins in ${SETTINGS_PATH}. Once each project ran ${cmd('kette add')}, switch them off with: ${cmd(legacy.map((id) => `claude plugin uninstall ${id}`).join(' && '))}`);
    if (!opts.ci && hasClaude()) doctorLine(line, info);
    const roundOne = opts.ci || !fs.existsSync(roundOneDir()) ? [] : registeredAt(roundOneDir());
    if (fs.existsSync(roundOneDir())) warn(`${tilde(roundOneDir())} is left from an earlier 0.10 build${roundOne.length ? ` and Claude Code still has ${roundOne.join(', ')} registered on it` : ''}. Clean up with: ${cmd('kette update')}`);
  }
  let editionHere = tier;
  if (project) {
    let raw = null;
    let broken = null;
    try { raw = readProfile(root); } catch (err) { broken = err.message; }
    const profile = normalizeProfile(raw);
    // Outside a project only --ci counts a missing profile, a person just gets told where to go
    if (broken) line(false, '', `.kette/profile.json is not readable (${broken}). Fix the file, then run ${cmd('kette doctor')} again`);
    else if (profile || opts.ci) line(Boolean(profile), '.kette/profile.json present', '.kette/profile.json missing');
    else info(`No kette project in this folder. cd into your project or run ${cmd('kette init')}. Plugins are enabled per project.`);
    if (raw && isLegacyTier(raw.tier)) warn(`Profile uses the old value tier "${raw.tier}", read as "${profile.tier}". Change it to "${profile.tier}" in .kette/profile.json.`);
    const inst = profile?.instance ? instanceChecks(profile, { line, warn }) : null;
    // An instance that cannot be used counts as Community for every check (fail closed)
    if (profile) editionHere = profile.instance ? (inst ? inst.edition : COMMUNITY) : Object.hasOwn(RANK, profile.tier) ? profile.tier : COMMUNITY;
    const own = profile ? installedBundle(editionHere) : null;
    if (profile && editionHere !== tier) {
      if (own) info(`Rulebook of this project in ${file(tilde(path.dirname(own.dir)))} ${dim(`(${editionLabel(editionHere)}, version ${own.version})`)}`);
      else if (editionHere === COMMUNITY) warn(`The Community rulebook for this project is not on this machine. Load it with: ${cmd('kette update')}`);
    }
    // The schema of the project edition, otherwise of this machine (an Enterprise project on a Community machine still gets checked)
    const checkWith = own || bundle;
    if (profile && checkWith) {
      const schema = loadSchema(checkWith.dir);
      const errs = validate(schema, forSchema(schema, profile));
      // A profile written by a newer CLI may name app folders the installed rulebook does not know yet: that needs an update, not a fix
      if (errs.length === 1 && errs[0] === '$: unknown field apps' && !schema.properties?.apps) warn(`The profile names app folders (apps), the installed rulebook does not know them yet. Load the current one with: ${cmd('kette update')}`);
      // Same for the review flow: a profile with flow needs a rulebook that knows it
      else if (errs.length === 1 && errs[0] === '$: unknown field flow' && !schema.properties?.flow) warn(`The profile sets the review flow (flow), the installed rulebook does not know it yet. Load the current one with: ${cmd('kette update')}`);
      else line(errs.length === 0, 'Profile valid', `Profile not valid: ${errs.join('; ')}`);
      if (PREVIEW.includes(platformStatus(checkWith.dir, profile.platform?.id))) warn(`Platform ${profile.platform.id} is still a preview ${dim('(no verified reference project)')}`);
      // With an instance the edition is the instance's choice, instanceChecks reports a missing licence
      if (!inst && profile.tier === ENTERPRISE && tier !== ENTERPRISE) warn(`Profile requires the Enterprise edition (Die Kette), only Community is installed here. Agents, gates, /feature-loop, platform profiles and checks from .kette/README.md are missing. Unlock with: ${cmd('kette login <key>')}`);
      if (!profile.instance && profile.tier !== ENTERPRISE && tier === ENTERPRISE) warn(`Enterprise (Die Kette) is installed here, the project is on Community. Switch to the flow with agents and gates: ${cmd('kette add')}`);
      // Overlays the project inherits from its instance count the same as its own
      for (const o of inherit(profile, inst).overlays || []) warn(`Overlay ${printable(o.source)}${profile.overlays?.some((x) => x.source === o.source) ? '' : ` (from instance ${inst.name})`} is loaded by the agents, not checked here`);
      // Community has kette-check only; other reviewers in flow.review are Enterprise agents
      const reviewers = [...(profile.flow?.review?.ui || []), ...(profile.flow?.review?.code || [])];
      const enterpriseOnly = reviewers.filter((r) => !COMMUNITY_REVIEWERS.includes(r));
      if (editionHere !== ENTERPRISE && enterpriseOnly.length) warn(`flow.review names ${enterpriseOnly.join(', ')}, these are agents of Die Kette (Enterprise). On Community only kette-check runs. Unlock with: ${cmd('kette login <key>')}`);
    }
    if (profile?.instance && editionHere === COMMUNITY) leftoverChecks(root, profile.instance, { line });
    if (profile && !opts.ci) projectPluginChecks(root, editionHere, profile.instance, { line, warn });
    if (!opts.ci && own && profile) printPluginDetails(editionHere, info);
    if (tier === ENTERPRISE && editionHere === ENTERPRISE) await npmChecks(root, { line, warn }, opts);
    // A repo that came to Enterprise through kette instance use has no templates yet; kette add renders them (QA-22)
    if (profile && own && editionHere === ENTERPRISE && !opts.ci) {
      const missing = (templatesFor(own.dir, profile, detectWorkspace(root)).templates?.files || []).map((f) => f.path).filter((p) => !fs.existsSync(path.join(root, p)));
      if (missing.length) warn(`Enterprise templates not in this project yet: ${missing.join(', ')}. Add them with: ${cmd('kette add')}`);
    }
    walletDoctor(root, editionHere === ENTERPRISE ? tier : COMMUNITY, { line, warn, info }, { project: Boolean(profile) });
    const md = path.join(root, 'CLAUDE.md');
    if (profile) line(fs.existsSync(md) && fs.readFileSync(md, 'utf8').includes('@.kette/README.md'), 'CLAUDE.md points to the Die Kette rules', `CLAUDE.md does not point to the Die Kette rules (line @.kette/README.md missing), add it with: ${cmd('kette add')}`);
  }
  // Warnings never fail doctor, but the closing line counts them so "all good" does not hide them
  const warned = warnings ? `, ${warnings} warning${warnings === 1 ? '' : 's'}` : '';
  console.log(`\n${problems ? bold(error(`${problems} open issue(s)${warned}`)) : bold(accent(`all good${warned}`))}`);
  return problems ? 1 : 0;
}

// The instance named in the profile: present, edition matches the profile, licence for Enterprise, bundle pin
function instanceChecks(profile, { line, warn }) {
  let inst;
  try { inst = readInstance(profile.instance); } catch (err) { line(false, '', `${err.message} The project counts as Community until it is fixed.`); return null; }
  if (!inst) { line(false, '', `${notFound(profile.instance)}. The project counts as Community until then.`); return null; }
  line(true, `Instance ${inst.name} ${dim(`(${editionLabel(inst.edition)}, ${instanceSource(inst.name).kind})`)}`);
  if (inst.edition === ENTERPRISE) line(tierOf() === ENTERPRISE, 'Licence for the Enterprise instance', `Instance ${inst.name} is Enterprise, this machine has no valid licence. Sign in with: ${cmd('kette login <key>')}`);
  if (profile.tier !== inst.edition) warn(`Profile says tier ${profile.tier}, instance ${inst.name} is ${inst.edition}. Align with: ${cmd(`kette instance use ${inst.name}`)}`);
  const bundle = installedBundle(inst.edition);
  if (inst.bundle && bundle && inst.bundle !== bundle.version) warn(`Instance ${inst.name} pins bundle ${inst.bundle}, this machine has ${bundle.version}. kette keeps one active bundle per edition; the pin is a check, not a switch (docs/instances.md).`);
  return inst;
}

// A Community project holds nothing kette wrote for Enterprise: no registry scope line, no Enterprise template it recorded
function leftoverChecks(root, instanceName, { line }) {
  const { files, npmrc } = enterpriseLeftovers(root, scopeLine().trim());
  const fix = cmd(`kette instance use ${instanceName}`);
  // A user npmrc from before 0.10 still points the scope to Die Kette for every folder; only a project line can override it (CR-NEW-8)
  if (globalScope() && !projectScope(readFile(path.join(root, '.npmrc')))) line(false, '', `npm in this Community project resolves ${SCOPE} from the Enterprise registry (line in the user npmrc from before 0.10). Move it with: ${cmd(MOVE_SCOPE)}`);
  if (npmrc) line(false, '', `.npmrc of this Community project points ${SCOPE} to the Enterprise registry. Remove the line with: ${fix}`);
  const changed = files.filter((f) => f.changed).map((f) => f.path);
  const unchanged = files.filter((f) => !f.changed).map((f) => f.path);
  if (unchanged.length) line(false, '', `Enterprise templates in this Community project: ${unchanged.join(', ')}. Remove them with: ${fix}`);
  if (changed.length) line(false, '', `Enterprise templates changed by hand in this Community project: ${changed.join(', ')}. Delete them or keep them on purpose, then remove their entries from ${RECORD_PATH}`);
}

// The project settings switch on exactly the plugins of its edition; Claude Code has them installed when it is there
function projectPluginChecks(root, edition, instanceName, { line, warn }) {
  const fix = cmd(instanceName ? `kette instance use ${instanceName}` : 'kette add');
  const market = marketName(edition);
  const s = settingsStatus(root, edition);
  if (s.state === 'ok') line(true, `${SETTINGS_PATH} enables the ${editionLabel(edition)} plugins only`);
  else if (s.state === 'broken') line(false, '', `${s.file} is not a JSON object. Fix the file, then run ${fix}`);
  else if (s.state === 'missing') line(false, '', `${SETTINGS_PATH} missing, Claude Code has no Kette plugins for this project. Enable them with: ${fix}`);
  else line(false, '', `${s.local.length ? `${LOCAL_SETTINGS_PATH} overrides` : `${SETTINGS_PATH} does not match`} ${editionLabel(edition)} (${s.wrong.join(', ')}). Fix with: ${fix}`);
  if (!hasClaude()) return;
  const list = installedPlugins(root);
  if (list === null) { line(false, 'Claude Code plugin list not readable (claude plugin list fails)'); return; }
  const bundle = installedBundle(edition);
  for (const p of pluginsFor(edition)) {
    if (!bundle || !pluginContents(bundle.dir, p)) warn(`Plugin ${pluginId(p, market)} is not in the ${editionLabel(edition)} bundle on this machine${edition === ENTERPRISE ? `, it needs the licence: ${cmd('kette login <key>')}` : `, load it with: ${cmd('kette update')}`}`);
    else line(pluginInstalled(p, list, market), `Plugin ${pluginId(p, market)} installed`, `Plugin ${pluginId(p, market)} not installed. Install with: ${fix}`);
  }
}

// Wallet gate: a repo without instance as before (edition of the machine), a repo of an instance only with an usable Enterprise instance
function walletTier(root) {
  let project;
  try { project = resolveProject(root); } catch { return COMMUNITY; }
  if (!project.profile?.instance) return tierOf();
  return project.edition === ENTERPRISE ? tierOf() : COMMUNITY;
}

// --effective adds what the project inherits from its instance; repo values win, the edition comes from the instance;
// an instance that cannot be read stops with its name instead of printing the profile as if nothing was inherited
function showProfile(root, opts) {
  const p = readProfile(root);
  if (!p) { console.log('No .kette/profile.json in this folder.'); return 1; }
  if (!opts.effective || !p.instance) { console.log(JSON.stringify(p, null, 2)); return 0; }
  const { instance, problem } = resolveProject(root);
  if (problem) throw new ExitError(problem, 1);
  console.log(JSON.stringify(inherit(p, instance), null, 2));
  return 0;
}

// Platform status from the bundle index; older bundles use the German word
const PREVIEW = ['preview', 'vorschau'];

// What each plugin of the edition brings, counted from the installed bundle
function printPluginDetails(tier, info) {
  info('Plugin contents:');
  const { tee, end, bar } = symbols();
  const details = pluginDetails(tier, marketName(tier), installedBundle(tier)?.dir);
  details.forEach(({ id, lines }, i) => {
    const last = i === details.length - 1;
    console.log(`      ${dim(last ? end : tee)} ${id}`);
    for (const l of lines) console.log(`      ${dim(last ? ' '.repeat(bar.length) : bar)}   ${dim(l)}`);
  });
}

// Renews the kette block in .kette/README.md when kette update runs inside a project; left alone when its instance cannot be used
function renewProjectNote(root) {
  const project = resolveProject(root);
  if (!project.profile || project.problem) return;
  const { profile } = project;
  const tier = project.instance ? project.edition : Object.hasOwn(RANK, profile.tier) ? profile.tier : COMMUNITY;
  const [d] = describe([noteItem(tier, profile.flow)], root);
  if (d.unmarked) { console.log(staleNote([d])); return; }
  if (d.action === 'keep') return;
  apply([d], root);
  console.log(`${file(NOTE_PATH)} ${d.action === 'create' ? 'created' : 'updated'} (flow for ${editionLabel(tier)}).`);
}

// After a bundle changed: the plugins of the project in this folder; outside a project nothing, plugins are enabled per project
// An instance that cannot be used only warns: login and update finish, nothing is enabled for that project (fail closed)
async function refreshProjectPlugins(root, opts) {
  if (opts.noPlugins || opts.dryRun) return;
  let project;
  try { project = resolveProject(root); } catch (err) { console.log(`${status('warn', 'WARN')} .kette/profile.json not readable (${err.message}), plugins of this project left as they are.`); return; }
  if (!project.profile) { console.log(dim(`Claude Code plugins are enabled per project: run ${cmd('kette add')} in each project.`)); return; }
  if (project.problem) { console.log(`${status('warn', 'WARN')} ${project.problem}. Plugins of this project left as they are, see ${cmd('kette doctor')}`); return; }
  const { edition } = project;
  try {
    if (edition === COMMUNITY && !installedBundle(COMMUNITY)) await ensureBundle(COMMUNITY);
    for (const d of writeProjectSettings(root, edition).filter((x) => x.action !== 'keep')) console.log(`${file(d.path)} ${d.action === 'create' ? 'created' : 'updated'}`);
    const r = enableProjectPlugins(root, edition, installedBundle(edition));
    if (r.ok && r.present.length) console.log(`Claude Code plugins enabled for this project: ${r.present.map((p) => pluginId(p, r.market)).join(', ')}`);
    for (const l of enableHints(r, edition)) console.log(l);
  } catch (err) {
    console.log(`${status('warn', 'WARN')} Plugins of this project not updated (${err.message}). Try again with: ${cmd('kette add')}`);
  }
}

// The shared marketplace folder of the unreleased first 0.10 build (~/.kette/bundles/marketplace), with what Claude Code registered on it
const roundOneDir = () => path.join(bundlesDir(), 'marketplace');

// The legacy marketplace kette goes back to ~/.kette/bundles/active (repointed, never removed: removing it would empty the user-scope
// plugins of 0.9 in the user settings, QA-28); without that folder everything stays as it is and doctor keeps naming it
function cleanRoundOne(opts) {
  if (opts.dryRun || !fs.existsSync(roundOneDir())) return;
  const names = registeredAt(roundOneDir());
  if (names.length && !fs.existsSync(activeBundleLink())) {
    console.log(`${status('warn', 'WARN')} ${names.join(', ')} still point to ${tilde(roundOneDir())} (an earlier 0.10 build). Load the rulebook first, then run ${cmd('kette update')} again.`);
    return;
  }
  for (const name of names) {
    const r = name === MARKETPLACE ? repointMarketplace(activeBundleLink()) : removeMarketplace(name);
    if (r.ok) console.log(`Marketplace ${name} no longer points to ${tilde(roundOneDir())} (an earlier 0.10 build)${name === MARKETPLACE ? `, it points to ${tilde(activeBundleLink())} again` : ''}.`);
    else return;
  }
  fs.rmSync(roundOneDir(), { recursive: true, force: true });
}

async function update(opts) {
  cleanRoundOne(opts);
  let code = await (credentialsStatus() === 'valid' ? updateEnterprise(opts, VERSION) : updateCommunity(opts));
  // A Community project on a machine with a licence needs the Community bundle as well; an instance that cannot be used counts as Community
  if (code === 0 && credentialsStatus() === 'valid' && safeEdition('.') === COMMUNITY) code = await updateCommunity(opts, { activate: false });
  if (code === 0 && !opts.dryRun) {
    renewProjectNote('.');
    await refreshProjectPlugins('.', opts);
  }
  return code;
}

// The edition of the project in a folder for every gate, null outside a project or with an unreadable profile
const safeEdition = (root) => { try { return resolveProject(root).edition; } catch { return null; } };

// activate: point the rulebook link to it (the edition of this machine), not for the extra Community bundle on an Enterprise machine
async function updateCommunity(opts, { activate = true } = {}) {
  const manifest = await fetchManifest();
  const tier = COMMUNITY;
  const have = installedBundle(tier);
  if (have?.version === manifest.version) {
    console.log(`Up to date (${activate ? '' : `${editionLabel(tier)} `}version ${manifest.version}).`);
    return 0;
  }
  console.log(`New ${activate ? '' : `${editionLabel(tier)} `}version ${manifest.version}${have ? ` (installed: ${have.version})` : ''}.`);
  if (manifest.changelog) console.log(manifest.changelog);
  if (opts.dryRun) return 0;
  const dir = await installBundle(manifest, tier);
  if (activate) {
    setActiveBundle(dir);
    await cliHint(VERSION, manifest);
  }
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
    if (command === 'doctor') return opts.instance ? await doctorInstance(opts, { doctor }) : await doctor('.', opts);
    if (command === 'update') return await update(opts);
    if (command === 'rules') {
      // In a project the rules of its edition, a Community project never sees the Enterprise bundle
      const tier = safeEdition('.') === COMMUNITY ? COMMUNITY : tierOf();
      return rules(arg, opts, { bundle: installedBundle(tier), tier, stackIds: STACKS.map((x) => x.value) });
    }
    if (command === 'profile') return showProfile('.', opts);
    if (command === 'instance') return await instanceCommand(arg, opts, { useInstance });
    if (command === 'login') return await login(arg, opts, VERSION, () => refreshProjectPlugins('.', opts));
    if (command === 'logout') return await logout(opts);
    if (command === 'token') {
      const [, kind, action, value] = opts._;
      if (kind !== 'ci') throw new Error('Usage: kette token ci create <label> | list | revoke <id>');
      return await ciToken(action, value);
    }
    if (command === 'figma') return await figma(opts);
    if (command === 'npm') return await npmCommand(arg);
    // The licence email only prefills the signup of an active Enterprise licence
    if (command === 'cloud') return await cloud(arg, opts, { email: tierOf() === ENTERPRISE ? loginState()?.email : null });
    // The wallet is Enterprise: in a Community instance, or one that cannot be used, it stays locked even on a machine with a licence
    if (command === 'wallet') return await wallet(arg, opts, { tier: walletTier('.') });
    if (command === 'theme') return await theme(opts, { version: VERSION });
    // Ticketing is Enterprise and project scoped: board, stations and members from the instance of the repo in this folder
    if (command === 'ticket') return await ticket(arg, opts, { resolveProject, spawnSync });
    if (command === 'state') { console.log(JSON.stringify({ home: home(), mirror: mirror(), delivery: delivery(), ...redactedState() }, null, 2)); return 0; }
    console.error(`Unknown command: ${command}\n`);
    console.log(help());
    return 1;
  } finally {
    close();
  }
}
