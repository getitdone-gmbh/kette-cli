import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { COMMUNITY, ENTERPRISE, editionLabel } from '../editions.mjs';
import { ask, choose, confirm } from '../prompt.mjs';
import { tierOf } from '../enterprise.mjs';
import { ExitError } from '../errors.mjs';
import { stateFile } from '../paths.mjs';
import { bold, cmd, dim, file, status } from '../out.mjs';
import { tilde } from '../rules.mjs';
import {
  EDITIONS, INSTANCE_FILE, ROLES, checkouts, forgetInstance, instanceDir, instanceExists, instanceFile, instanceSource, listInstances, newInstance,
  printable, readInstance, redact, repoIdentity, setCheckout, updateInstance, validName, validateInstance, withRepo, withoutRepo, writeInstance,
} from './config.mjs';

export const INSTANCE_HELP = `kette instance create <name> [--edition enterprise|community] [--from <git-url|folder>]
                        A Kette instance with its own scope: edition, repos, members, ticketing, wallet, rules
  kette instance list | show [name] | use <name> | add-repo [path] | remove <name> --yes
  kette instance members [add <id> [--role owner|member] | remove <id>]`;

const USAGE = `Usage: ${INSTANCE_HELP.split('\n').filter((l) => l.trim().startsWith('kette')).map((l) => l.trim()).join(' | ')}`;

const say = (kind, msg) => console.log(`${status(kind, kind === 'ok' ? 'OK  ' : kind.toUpperCase())} ${msg}`);

// An Enterprise instance needs the licence on this machine; a Community instance stays Community even with a licence
export function requireEdition(instance) {
  if (instance.edition === ENTERPRISE && tierOf() !== ENTERPRISE) throw new ExitError(`Instance ${instance.name} is Enterprise (Die Kette), this machine has no valid licence. Sign in with: ${cmd('kette login <key>')}`, 1);
  return instance.edition;
}

// The instance or a stop with the reason: an unsafe name, a damaged file, or not on this machine
function load(name) {
  if (!validName(name)) throw new ExitError(`Instance names use lowercase letters, digits and dashes: ${JSON.stringify(printable(name))}`);
  let instance;
  try { instance = readInstance(name); } catch (err) { throw new ExitError(err.message, 1); }
  if (!instance) throw new ExitError(`Instance ${name} not found on this machine. Create it with ${cmd(`kette instance create ${name}`)} or clone it with ${cmd(`kette instance create ${name} --from <git-url>`)}`, 1);
  return instance;
}

// The instance named in a repo profile: broken when the file cannot be read
function profileState(root) {
  const f = path.join(root, '.kette', 'profile.json');
  if (!fs.existsSync(f)) return { instance: null, broken: null };
  try { return { instance: JSON.parse(fs.readFileSync(f, 'utf8')).instance || null, broken: null }; } catch (err) { return { instance: null, broken: err.message }; }
}

const profileInstance = (root) => profileState(root).instance;

// Which instance a command means: the argument, --instance, the instance of the repo in this folder, or the only one there is
function resolveName(arg, opts) {
  const name = arg || (typeof opts.instance === 'string' ? opts.instance : null) || profileInstance('.');
  if (name) return name;
  const all = listInstances();
  if (all.length === 1) return all[0];
  throw new ExitError(all.length ? `Name the instance (${all.join(', ')}), e.g. with --instance <name>.` : `No instance on this machine yet. Create one with: ${cmd('kette instance create <name>')}`, 1);
}

// Changes in an instance repo reach the team only after a commit and push
function shareHint(name) {
  const source = instanceSource(name);
  return source.kind === 'local' ? null : dim(`${INSTANCE_FILE} lives in the instance repo ${tilde(source.path)}. Commit and push the change so the team and agents see it.`);
}

// Only https, ssh and local repos; no prompt for a password and no stdin, so a transport like ext:: or fd:: can neither run nor hang
const CLONE = ['-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'protocol.ssh.allow=always', '-c', 'protocol.file.allow=always', 'clone', '--quiet', '--'];

function cloneOrLink(name, from) {
  const dir = instanceDir(name);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  // A checked out instance repo (a folder with instance.json) is linked; anything else, also a local bare repo, is cloned
  if (fs.existsSync(path.join(from, INSTANCE_FILE))) {
    fs.symlinkSync(path.resolve(from), dir, 'junction');
    return () => fs.unlinkSync(dir);
  }
  if (from.startsWith('-')) throw new ExitError(`--from must be a git URL or a folder: ${redact(from)}`);
  const r = spawnSync('git', [...CLONE, from, dir], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '' } });
  if (r.status !== 0) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new ExitError(`git clone ${redact(from)} failed: ${redact((r.stderr || r.stdout || '').trim() || r.error?.message || 'no reason given')}`, 1);
  }
  return () => fs.rmSync(dir, { recursive: true, force: true });
}

async function create(name, opts) {
  if (!name) throw new ExitError(USAGE);
  if (!validName(name)) throw new ExitError(`Instance names use lowercase letters, digits and dashes, and no name Windows reserves: ${JSON.stringify(printable(name))}`);
  if (instanceExists(name)) {
    const dangling = instanceSource(name).dangling;
    throw new ExitError(dangling ? `Instance ${name} is a link whose instance repo is gone. Remove it with ${cmd(`kette instance remove ${name} --yes`)}, then create it again.` : `Instance ${name} exists already. Show it with: ${cmd(`kette instance show ${name}`)}`, 1);
  }
  if (opts.edition && !EDITIONS.includes(opts.edition)) throw new ExitError(`--edition must be ${EDITIONS.join(' or ')}`);
  if (opts.from) {
    if (opts.dryRun) { console.log(`Would clone or link ${redact(opts.from)} to ${tilde(instanceDir(name))}.`); return 0; }
    const undo = cloneOrLink(name, opts.from);
    let instance;
    try {
      instance = load(name);
      if (opts.edition && opts.edition !== instance.edition) throw new ExitError(`${redact(opts.from)} is a ${instance.edition} instance, not ${opts.edition}.`, 1);
      requireEdition(instance);
    } catch (err) {
      undo();
      throw err;
    }
    say('ok', `Instance ${name} (${editionLabel(instance.edition)}) from ${redact(opts.from)} in ${file(tilde(instanceDir(name)))}`);
    return next(name);
  }
  const edition = opts.edition || tierOf();
  const instance = newInstance(name, edition);
  requireEdition(instance);
  if (opts.dryRun) { console.log(JSON.stringify(instance, null, 2)); return 0; }
  writeInstance(instance);
  say('ok', `Instance ${name} (${editionLabel(edition)}) in ${file(tilde(instanceDir(name)))}`);
  return next(name);
}

function next(name) {
  console.log(`Next: in each repo of the instance ${cmd(`kette instance use ${name}`)} (a new repo: ${cmd(`kette add --instance ${name}`)}).`);
  return 0;
}

function list() {
  const names = listInstances();
  if (!names.length) { console.log(`No instance on this machine yet. Repos without an instance use the edition of this machine (${editionLabel(tierOf())}). Create one with: ${cmd('kette instance create <name>')}`); return 0; }
  const here = profileInstance('.');
  for (const name of names) {
    let detail;
    try {
      const source = instanceSource(name);
      if (source.dangling) throw new Error(`link to ${tilde(source.path)}, which is gone`);
      const i = readInstance(name);
      detail = `${editionLabel(i.edition)}, ${i.repos.length} repo${i.repos.length === 1 ? '' : 's'}, ${source.kind}`;
    } catch (err) {
      detail = `damaged: ${printable(err.message)}`;
    }
    console.log(`${name === here ? '*' : ' '} ${bold(name)}  ${dim(detail)}`);
  }
  if (here) console.log(dim('* used by the repo in this folder'));
  return 0;
}

// Checkouts of a repo of the instance on this machine, by path
const checkoutsOf = (local, repo) => Object.entries(local).filter(([, c]) => c.repo === repo).map(([dir]) => dir).sort();

function show(arg, opts) {
  const name = resolveName(arg, opts);
  const i = load(name);
  if (opts.json) { console.log(JSON.stringify(i, null, 2)); return 0; }
  const source = instanceSource(name);
  const local = checkouts(name);
  const rows = [
    ['Instance', i.name],
    ['Edition', editionLabel(i.edition)],
    ['Stored', `${tilde(source.path)} (${source.kind})`],
    ['Bundle pin', i.bundle || 'none, the installed bundle'],
    ['Ticketing', i.ticketing ? `${i.ticketing.adapter} ${i.ticketing.project}` : 'none'],
    ['Wallet', i.wallet ? [i.wallet.provider, i.wallet.project, i.wallet.env].filter(Boolean).join(' ') : 'none'],
    ['Overlays', (i.overlays || []).map((o) => o.source).join(', ') || 'none'],
    ['Stations', (i.stations || []).join(', ') || 'none'],
  ];
  for (const [k, v] of rows) console.log(`${bold(k.padEnd(11))} ${printable(v)}`);
  console.log(bold('Repos'));
  for (const r of i.repos) {
    const dirs = checkoutsOf(local, r.name);
    console.log(`  ${printable(r.name)}${r.url ? dim(` ${redact(r.url)}`) : ''}  ${dirs.length ? dirs.map((d) => file(tilde(d))).join(', ') : dim('not checked out on this machine')}`);
  }
  if (!i.repos.length) console.log(dim(`  none yet: ${cmd(`kette instance use ${name}`)} in a repo`));
  console.log(bold('Members'));
  for (const m of i.members) console.log(`  ${printable(m.id)} ${dim(m.role)}`);
  if (!i.members.length) console.log(dim(`  none yet: ${cmd(`kette instance members add <id> --instance ${name}`)}`));
  return 0;
}

// Everything that can stop a repo from joining, checked before a file of the project is written (QA-09)
export function prepareJoin(name, dir) {
  const instance = load(name);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new ExitError(`${dir} is not a folder.`, 1);
  const id = repoIdentity(dir);
  withRepo(instance, id, checkouts(name));
  for (const [f, what] of [[instanceFile(name), `${INSTANCE_FILE} of instance ${name}`], [path.dirname(instanceFile(name)), `the folder of instance ${name}`]]) {
    try { fs.accessSync(f, fs.constants.W_OK); } catch { throw new ExitError(`${what} is not writable (${tilde(f)}). Nothing in the project was changed.`, 1); }
  }
  if (fs.existsSync(stateFile())) {
    try { fs.accessSync(stateFile(), fs.constants.W_OK); } catch { throw new ExitError(`${tilde(stateFile())} is not writable. Nothing in the project was changed.`, 1); }
  }
  return id;
}

// One repo belongs to one instance (docs/adr/0002, decision 12): it joins this one and leaves every other; lines to print
export function joinInstance(name, dir) {
  const id = repoIdentity(dir);
  const lines = [];
  for (const other of listInstances().filter((n) => n !== name)) {
    let removed;
    try { removed = readInstance(other) && withoutRepo(other, id); } catch { removed = null; }
    if (!removed) continue;
    lines.push(`${status('ok', 'OK  ')} ${printable(removed)} removed from instance ${other}`);
    const hint = shareHint(other);
    if (hint) lines.push(hint);
  }
  let repo;
  let added = false;
  updateInstance(name, (instance) => {
    const r = withRepo(instance, id, checkouts(name));
    ({ repo, added } = r);
    return r.added ? r.instance : instance;
  });
  setCheckout(name, id.path, repo.name, id.key);
  if (added) {
    lines.push(`${status('ok', 'OK  ')} ${printable(repo.name)} added to instance ${name}`);
    const hint = shareHint(name);
    if (hint) lines.push(hint);
  }
  return lines;
}

function addRepoCmd(arg, opts) {
  const name = resolveName(null, opts);
  const dir = arg || '.';
  prepareJoin(name, dir);
  const lines = joinInstance(name, dir);
  for (const l of lines) console.log(l);
  if (!lines.length) say('ok', `${path.basename(fs.realpathSync(dir))} is already in instance ${name}`);
  if (profileInstance(dir) !== name) console.log(`Next: in ${tilde(fs.realpathSync(dir))} ${cmd(`kette instance use ${name}`)}, so the repo takes the edition and settings of the instance.`);
  return 0;
}

async function use(name, opts, deps) {
  if (!name) throw new ExitError(USAGE);
  const instance = load(name);
  requireEdition(instance);
  const { broken } = profileState('.');
  if (broken) throw new ExitError(`.kette/profile.json is not readable (${broken}). Fix the file first.`, 1);
  if (!fs.existsSync(path.join('.', '.kette', 'profile.json'))) throw new ExitError(`No kette project in this folder. Connect it to the instance with: ${cmd(`kette add --instance ${name}`)}`, 1);
  return deps.useInstance('.', instance, opts);
}

function members(action, id, opts) {
  const name = resolveName(null, opts);
  const instance = load(name);
  if (!action || action === 'list') {
    if (!instance.members.length) console.log(`Instance ${name} has no members yet. Add one with: ${cmd(`kette instance members add <id> --instance ${name}`)}`);
    for (const m of instance.members) console.log(`${printable(m.id)} ${dim(m.role)}`);
    return 0;
  }
  if (!['add', 'remove'].includes(action)) throw new ExitError(`Unknown members action: ${printable(action)}. Use add, remove or list.`);
  if (!id) throw new ExitError(`Usage: kette instance members ${action} <id>`);
  const same = (m) => m.id.toLowerCase() === id.toLowerCase();
  const role = opts.role || 'member';
  if (action === 'add') {
    if (!ROLES.includes(role)) throw new ExitError(`--role must be ${ROLES.join(' or ')}`);
    const errs = validateInstance({ ...newInstance(name, instance.edition), members: [{ id, role }] });
    if (errs.length) throw new ExitError(`Member id ${JSON.stringify(printable(id))} is not valid: one line of at most 200 characters, no control characters.`);
  } else if (!instance.members.some(same)) throw new ExitError(`${printable(id)} is not a member of ${name}.`, 1);
  updateInstance(name, (i) => ({ ...i, members: action === 'add' ? [...i.members.filter((m) => !same(m)), { id, role }] : i.members.filter((m) => !same(m)) }));
  say('ok', `${printable(id)} ${action === 'add' ? `is ${role} of` : 'removed from'} instance ${name}`);
  const hint = shareHint(name);
  if (hint) console.log(hint);
  return 0;
}

// Never deletes an instance repo: a link (also one whose target is gone) is unlinked, a clone is left for the person to delete;
// works without reading instance.json, so a damaged instance can be removed too
function remove(name, opts) {
  if (!name) throw new ExitError('Usage: kette instance remove <name> --yes');
  if (!validName(name)) throw new ExitError(`Instance names use lowercase letters, digits and dashes: ${JSON.stringify(printable(name))}`);
  if (!instanceExists(name)) throw new ExitError(`Instance ${name} not found on this machine.`, 1);
  const source = instanceSource(name);
  if (source.kind === 'clone') throw new ExitError(`Instance ${name} is a git clone of an instance repo in ${tilde(source.path)}. kette never deletes an instance repo; delete the folder yourself once its changes are pushed.`, 1);
  if (!opts.yes) throw new ExitError(`This removes instance ${name} from this machine${source.kind === 'link' ? ' (only the link, the instance repo stays)' : ''}. Repeat with --yes.`, 1);
  if (source.kind === 'link') fs.unlinkSync(instanceDir(name));
  else fs.rmSync(instanceDir(name), { recursive: true, force: true });
  forgetInstance(name);
  say('ok', `Instance ${name} removed from this machine. Repos that name it keep their profile, ${cmd('kette doctor')} reports them.`);
  return 0;
}

// kette doctor --instance: the machine once, then every checkout of every repo of the instance on this machine
export async function doctorInstance(opts, { doctor }) {
  const name = resolveName(null, opts);
  const instance = load(name);
  console.log(bold(`Instance ${name} (${editionLabel(instance.edition)})`));
  let failed = (await doctor('.', opts, { project: false })) !== 0;
  const local = checkouts(name);
  let good = 0;
  let total = 0;
  let away = 0;
  for (const repo of instance.repos) {
    const dirs = checkoutsOf(local, repo.name);
    if (!dirs.length) { away++; console.log(`\n${bold(printable(repo.name))} ${dim('not checked out on this machine')}`); continue; }
    for (const dir of dirs) {
      total++;
      console.log(`\n${bold(printable(repo.name))} ${dim(tilde(dir))}`);
      if (!fs.existsSync(dir)) { say('fail', `${tilde(dir)} is gone. Check it out again and run ${cmd(`kette instance add-repo <path> --instance ${name}`)}`); failed = true; continue; }
      const { instance: uses, broken } = profileState(dir);
      if (broken) { say('fail', `${printable(repo.name)}: .kette/profile.json is not readable (${printable(broken)}). Fix the file, then run ${cmd(`kette instance use ${name}`)} in ${tilde(dir)}`); failed = true; continue; }
      if (uses !== name) { say('fail', `${printable(repo.name)} ${uses ? `uses instance ${printable(uses)}` : 'has no instance in .kette/profile.json'}. Fix in the repo with: ${cmd(`kette instance use ${name}`)}`); failed = true; continue; }
      if ((await doctor(dir, opts, { machine: false })) === 0) good++;
      else failed = true;
    }
  }
  console.log(`\n${bold(`Instance ${name}: ${good} of ${total} repo${total === 1 ? '' : 's'} all good`)}${away ? dim(`, ${away} not checked out here`) : ''}`);
  return failed ? 1 : 0;
}

const NEW = '+new';

// Onboarding of a new project: which instance it belongs to; none keeps the edition of this machine, as before instances
export async function askInstance(root) {
  const names = listInstances();
  const label = (n) => { try { return `Instance ${n} (${editionLabel(readInstance(n).edition)})`; } catch { return `Instance ${n} (damaged)`; } };
  const options = [
    { value: '', label: `None, the edition of this machine (${editionLabel(tierOf())})` },
    ...names.map((n) => ({ value: n, label: label(n) })),
    { value: NEW, label: 'A new instance with its own scope (edition, repos, members, ticketing, wallet)' },
  ];
  let pick;
  // An answer that is not one number of the list asks again instead of guessing
  for (;;) {
    const picked = await choose('Which Kette instance does this project belong to?', options, '1');
    if (picked.length === 1) { [pick] = picked; break; }
    console.log(`Choose one number from 1 to ${options.length}.`);
  }
  if (pick !== NEW) return pick ? { instance: load(pick), create: false } : null;
  const suggested = path.basename(path.resolve(root)).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+/, '').slice(0, 63) || 'project';
  for (;;) {
    const name = await ask('Name of the new instance', suggested);
    if (!validName(name)) { console.log('Use lowercase letters, digits and dashes.'); continue; }
    if (instanceExists(name)) {
      if (await confirm(`Instance ${name} exists already. Join it instead?`)) return { instance: load(name), create: false };
      continue;
    }
    const editions = [{ value: COMMUNITY, label: editionLabel(COMMUNITY) }, { value: ENTERPRISE, label: `${editionLabel(ENTERPRISE)}, needs the licence on this machine` }];
    let edition;
    for (;;) {
      const picked = await choose('Edition of the instance', editions, tierOf() === ENTERPRISE ? '2' : '1');
      if (picked.length === 1) { [edition] = picked; break; }
      console.log('Choose 1 or 2.');
    }
    const instance = newInstance(name, edition);
    requireEdition(instance);
    // Written by createPending after the person confirmed the plan, so "n" leaves no instance behind (QA-21)
    return { instance, create: true };
  }
}

// The new instance from the onboarding question, once the plan is confirmed
export function createPending(instance) {
  writeInstance(instance);
  say('ok', `Instance ${instance.name} (${editionLabel(instance.edition)}) in ${file(tilde(instanceDir(instance.name)))}`);
}

export async function instance(sub, opts, deps) {
  const [, , arg, value] = opts._;
  if (!sub || sub === 'help') { console.log(`Kette instances: each has its own scope (edition, repos, members, ticketing, wallet, rules).\n\n  ${INSTANCE_HELP}`); return 0; }
  if (sub === 'create') return await create(arg, opts);
  if (sub === 'list') return list();
  if (sub === 'show') return show(arg, opts);
  if (sub === 'use') return await use(arg, opts, deps);
  if (sub === 'add-repo') return addRepoCmd(arg, opts);
  if (sub === 'members') return members(arg, value, opts);
  if (sub === 'remove') return remove(arg, opts);
  throw new ExitError(`Unknown instance command: ${printable(sub)}. ${USAGE}`);
}
