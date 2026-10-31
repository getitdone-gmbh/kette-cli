import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { COMMUNITY, ENTERPRISE, editionLabel } from '../editions.mjs';
import { ask, choose } from '../prompt.mjs';
import { tierOf } from '../enterprise.mjs';
import { ExitError } from '../errors.mjs';
import { bold, cmd, dim, file, status } from '../out.mjs';
import { tilde } from '../rules.mjs';
import { EDITIONS, INSTANCE_FILE, ROLES, checkouts, dropCheckout, forgetInstance, instanceDir, instanceSource, listInstances, newInstance, readInstance, repoIdentity, setCheckout, validName, withRepo, writeInstance } from './config.mjs';

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

function load(name) {
  const instance = readInstance(name);
  if (!instance) throw new ExitError(`Instance ${name} not found on this machine. Create it with ${cmd(`kette instance create ${name}`)} or clone it with ${cmd(`kette instance create ${name} --from <git-url>`)}`, 1);
  return instance;
}

function profileInstance(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, '.kette', 'profile.json'), 'utf8')).instance || null; } catch { return null; }
}

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
  if (source.kind !== 'local') console.log(dim(`${INSTANCE_FILE} lives in the instance repo ${tilde(source.path)}. Commit and push the change so the team and agents see it.`));
}

function cloneOrLink(name, from) {
  const dir = instanceDir(name);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  // A checked out instance repo (a folder with instance.json) is linked; anything else, also a local bare repo, is cloned
  if (fs.existsSync(path.join(from, INSTANCE_FILE))) {
    fs.symlinkSync(path.resolve(from), dir, 'junction');
    return () => fs.unlinkSync(dir);
  }
  if (from.startsWith('-')) throw new ExitError(`--from must be a git URL or a folder: ${from}`);
  // ext:: would run a command, so it is switched off; -- ends the options before the URL
  const r = spawnSync('git', ['-c', 'protocol.ext.allow=never', 'clone', '--quiet', '--', from, dir], { encoding: 'utf8' });
  if (r.status !== 0) throw new ExitError(`git clone ${from} failed: ${(r.stderr || r.stdout || '').trim() || r.error?.message}`, 1);
  return () => fs.rmSync(dir, { recursive: true, force: true });
}

async function create(name, opts) {
  if (!name) throw new ExitError(USAGE);
  if (!validName(name)) throw new ExitError(`Instance names use lowercase letters, digits and dashes: ${name}`);
  if (fs.existsSync(instanceDir(name))) throw new ExitError(`Instance ${name} exists already. Show it with: ${cmd(`kette instance show ${name}`)}`, 1);
  if (opts.edition && !EDITIONS.includes(opts.edition)) throw new ExitError(`--edition must be ${EDITIONS.join(' or ')}`);
  if (opts.from) {
    if (opts.dryRun) { console.log(`Would clone or link ${opts.from} to ${tilde(instanceDir(name))}.`); return 0; }
    const undo = cloneOrLink(name, opts.from);
    let instance;
    try {
      instance = load(name);
      if (opts.edition && opts.edition !== instance.edition) throw new ExitError(`${opts.from} is a ${instance.edition} instance, not ${opts.edition}.`, 1);
      requireEdition(instance);
    } catch (err) {
      undo();
      throw err;
    }
    say('ok', `Instance ${name} (${editionLabel(instance.edition)}) from ${opts.from} in ${file(tilde(instanceDir(name)))}`);
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
      const i = readInstance(name);
      detail = `${editionLabel(i.edition)}, ${i.repos.length} repo${i.repos.length === 1 ? '' : 's'}, ${instanceSource(name).kind}`;
    } catch (err) {
      detail = `damaged: ${err.message}`;
    }
    console.log(`${name === here ? '*' : ' '} ${bold(name)}  ${dim(detail)}`);
  }
  if (here) console.log(dim(`* used by the repo in this folder`));
  return 0;
}

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
  for (const [k, v] of rows) console.log(`${bold(k.padEnd(11))} ${v}`);
  console.log(bold('Repos'));
  for (const r of i.repos) console.log(`  ${r.name}${r.url ? dim(` ${r.url}`) : ''}  ${local[r.name] ? file(tilde(local[r.name])) : dim('not checked out on this machine')}`);
  if (!i.repos.length) console.log(dim(`  none yet: ${cmd(`kette instance use ${name}`)} in a repo`));
  console.log(bold('Members'));
  for (const m of i.members) console.log(`  ${m.id} ${dim(m.role)}`);
  if (!i.members.length) console.log(dim(`  none yet: ${cmd(`kette instance members add <id> --instance ${name}`)}`));
  return 0;
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
  const [pick = ''] = await choose('Which Kette instance does this project belong to?', options, '1');
  if (pick !== NEW) return pick ? load(pick) : null;
  const suggested = path.basename(path.resolve(root)).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+/, '') || 'project';
  const name = await ask('Name of the new instance', suggested);
  if (!validName(name)) throw new ExitError(`Instance names use lowercase letters, digits and dashes: ${name}`);
  if (fs.existsSync(instanceDir(name))) return load(name);
  const editions = [{ value: COMMUNITY, label: editionLabel(COMMUNITY) }, { value: ENTERPRISE, label: `${editionLabel(ENTERPRISE)}, needs the licence on this machine` }];
  const [edition = COMMUNITY] = await choose('Edition of the instance', editions, tierOf() === ENTERPRISE ? '2' : '1');
  const instance = newInstance(name, edition);
  requireEdition(instance);
  writeInstance(instance);
  say('ok', `Instance ${name} (${editionLabel(edition)}) in ${file(tilde(instanceDir(name)))}`);
  return instance;
}

// Registers a repo folder with the instance and remembers where it is checked out on this machine
export function addRepo(name, dir) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new ExitError(`${dir} is not a folder.`, 1);
  const id = repoIdentity(dir);
  const { instance, repo, added } = withRepo(load(name), id);
  if (added) writeInstance(instance);
  setCheckout(name, repo.name, id.path);
  return { repo, added, path: id.path };
}

function addRepoCmd(arg, opts) {
  const name = resolveName(null, opts);
  const r = addRepo(name, arg || '.');
  say('ok', `${r.repo.name} ${r.added ? 'added to' : 'is already in'} instance ${name} ${dim(`(${tilde(r.path)})`)}`);
  if (r.added) shareHint(name);
  if (profileInstance(r.path) !== name) console.log(`Next: in ${tilde(r.path)} ${cmd(`kette instance use ${name}`)}, so the repo takes the edition and settings of the instance.`);
  return 0;
}

async function use(name, opts, deps) {
  if (!name) throw new ExitError(USAGE);
  const instance = load(name);
  requireEdition(instance);
  if (!fs.existsSync(path.join('.', '.kette', 'profile.json'))) throw new ExitError(`No kette project in this folder. Connect it to the instance with: ${cmd(`kette add --instance ${name}`)}`, 1);
  const previous = profileInstance('.');
  const code = await deps.useInstance('.', instance, opts);
  if (code !== 0 || opts.dryRun) return code;
  const r = addRepo(name, '.');
  if (r.added) { say('ok', `${r.repo.name} added to instance ${name}`); shareHint(name); }
  if (previous && previous !== name) leave(previous, r.path);
  return 0;
}

// A repo that switches instance leaves its old one, so it never shows up in two scopes
function leave(name, dir) {
  let instance;
  try { instance = readInstance(name); } catch { return; }
  if (!instance) return;
  const repo = Object.entries(checkouts(name)).find(([, d]) => d === dir)?.[0];
  if (!repo) return;
  writeInstance({ ...instance, repos: instance.repos.filter((r) => r.name !== repo) });
  dropCheckout(name, repo);
  say('ok', `${repo} removed from instance ${name}`);
  shareHint(name);
}

function members(action, id, opts) {
  const name = resolveName(null, opts);
  const instance = load(name);
  if (!action || action === 'list') {
    if (!instance.members.length) console.log(`Instance ${name} has no members yet. Add one with: ${cmd(`kette instance members add <id> --instance ${name}`)}`);
    for (const m of instance.members) console.log(`${m.id} ${dim(m.role)}`);
    return 0;
  }
  if (!id) throw new ExitError(`Usage: kette instance members ${action} <id>`);
  const same = (m) => m.id.toLowerCase() === id.toLowerCase();
  let next;
  if (action === 'add') {
    const role = opts.role || 'member';
    if (!ROLES.includes(role)) throw new ExitError(`--role must be ${ROLES.join(' or ')}`);
    next = [...instance.members.filter((m) => !same(m)), { id, role }];
  } else if (action === 'remove') {
    if (!instance.members.some(same)) throw new ExitError(`${id} is not a member of ${name}.`, 1);
    next = instance.members.filter((m) => !same(m));
  } else throw new ExitError(`Unknown members action: ${action}. Use add, remove or list.`);
  writeInstance({ ...instance, members: next });
  say('ok', `${id} ${action === 'add' ? `is ${opts.role || 'member'} of` : 'removed from'} instance ${name}`);
  shareHint(name);
  return 0;
}

// Never deletes an instance repo: a link is unlinked, a clone is left for the person to delete
function remove(name, opts) {
  if (!name) throw new ExitError('Usage: kette instance remove <name> --yes');
  load(name);
  const source = instanceSource(name);
  if (source.kind === 'clone') throw new ExitError(`Instance ${name} is a git clone of an instance repo in ${tilde(source.path)}. kette never deletes an instance repo; delete the folder yourself once its changes are pushed.`, 1);
  if (!opts.yes) throw new ExitError(`This removes instance ${name} from this machine${source.kind === 'link' ? ' (only the link, the instance repo stays)' : ''}. Repeat with --yes.`, 1);
  if (source.kind === 'link') fs.unlinkSync(instanceDir(name));
  else fs.rmSync(instanceDir(name), { recursive: true, force: true });
  forgetInstance(name);
  say('ok', `Instance ${name} removed from this machine. Repos that name it keep their profile, ${cmd('kette doctor')} reports them.`);
  return 0;
}

// kette doctor --instance: the machine once, then every repo of the instance that is checked out here
export async function doctorInstance(opts, { doctor }) {
  const name = resolveName(null, opts);
  const instance = load(name);
  console.log(bold(`Instance ${name} (${editionLabel(instance.edition)})`));
  let failed = (await doctor('.', opts, { project: false })) !== 0;
  const local = checkouts(name);
  let good = 0;
  for (const repo of instance.repos) {
    const dir = local[repo.name];
    console.log(`\n${bold(repo.name)} ${dim(dir ? tilde(dir) : 'not checked out on this machine')}`);
    if (!dir) continue;
    if (!fs.existsSync(dir)) { say('fail', `${tilde(dir)} is gone. Check it out again and run ${cmd(`kette instance add-repo <path> --instance ${name}`)}`); failed = true; continue; }
    const uses = profileInstance(dir);
    if (uses !== name) { say('fail', `${repo.name} ${uses ? `uses instance ${uses}` : 'has no instance in .kette/profile.json'}. Fix in the repo with: ${cmd(`kette instance use ${name}`)}`); failed = true; continue; }
    if ((await doctor(dir, opts, { machine: false })) === 0) good++;
    else failed = true;
  }
  const away = instance.repos.filter((r) => !local[r.name]).length;
  console.log(`\n${bold(`Instance ${name}: ${good} of ${instance.repos.length} repo${instance.repos.length === 1 ? '' : 's'} all good`)}${away ? dim(`, ${away} not checked out here`) : ''}`);
  return failed ? 1 : 0;
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
  throw new ExitError(`Unknown instance command: ${sub}. ${USAGE}`);
}
