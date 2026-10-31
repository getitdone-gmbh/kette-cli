import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { NO_TERMINAL, ask, askSecret, choose, confirm } from '../prompt.mjs';
import { readState, updateState } from '../manifest.mjs';
import { ENTERPRISE } from '../editions.mjs';
import { bold, cmd, dim, file, status } from '../out.mjs';
import { readInstance } from '../instance/config.mjs';
import { ExitError } from '../errors.mjs';
import { cmdLine } from '../claude.mjs';
import {
  DEFAULT_ENVIRONMENTS, DEFAULT_PROVIDER, PROVIDERS, PROVIDER_IDS, WALLET_PATH, checkEnv, checkName, exampleNames,
  NAME_PATTERN, namesFor, newWallet, parseDotenv, providerHash, readWallet, walletFile, writeWallet,
} from './config.mjs';
import { linkedProject, setupInfisical } from './infisical.mjs';
import { ProviderError, installHint, providerFor, providerVersion, spawnTool } from './providers.mjs';

export const WALLET_HELP = `kette wallet init     Secret wallet (Enterprise): create .kette/wallet.json. Infisical (default) is guided: sign-in,
                        project, environment check; previews: Vault, AWS, Azure; or your own commands
  kette wallet status   Which declared secrets are missing per environment (names only, never values)
  kette wallet add <name> | set <name> | remove <name>
                        Declare a secret (--env a,b --app name --note text), store its value (--env, hidden prompt
                        or --stdin), remove the declaration (the value stays in the provider)
  kette wallet run --env <env> -- <command>
                        Run a command with the declared secrets as environment variables (--app name narrows them)
  kette wallet sync github --env <env>
                        Copy the secrets into a GitHub environment after a yes (--github-env name, --repo owner/name)
  kette wallet import <file> --env <env>
                        Move the values of a .env file into the wallet, names only on screen, then delete the file
  kette wallet trust    Confirm the provider of .kette/wallet.json on this machine`;

const line = (kind, text) => console.log(`${status(kind, { ok: 'OK  ', warn: 'WARN', info: 'INFO', fail: 'FAIL' }[kind])} ${text}`);
const list = (s) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : null);
const TRUST_ENV = 'KETTE_WALLET_TRUST';
// The customer owns vault and credentials; kette and Get IT Done only pass values between this machine and that vault
export const OWNERSHIP = 'Your credentials live in your own Infisical (Cloud EU preselected, self-hosted possible) or another vault. Get IT Done never sees or stores a value and does not manage credentials for you (terms, section 10 (5)).';

// Provider block of a profile platform, kept in step when the wallet uses a store the schema knows
const PROFILE_SECRETS = { infisical: 'infisical', vault: 'vault', 'aws-secrets-manager': 'aws-secrets-manager', 'azure-key-vault': 'azure-key-vault' };

function requireEnterprise(tier) {
  if (tier !== ENTERPRISE) throw new ExitError(`The secret wallet is part of Enterprise (Die Kette). Unlock with: ${cmd('kette login <key>')}`, 1);
}

function requireWallet(root) {
  const wallet = readWallet(root);
  if (!wallet) throw new ExitError(`No ${WALLET_PATH} in this project. Create it with: ${cmd('kette wallet init')}`, 1);
  return wallet;
}

// A repo decides which provider and which commands run, so every machine confirms the provider block once (like direnv allow)
const trustKey = (root) => path.resolve(root);
export const isTrusted = (root, wallet) => process.env[TRUST_ENV] === '1' || readState().wallet_trust?.[trustKey(root)] === providerHash(wallet.provider);
function remember(root, wallet) {
  updateState((state) => ({ ...state, wallet_trust: { ...(state.wallet_trust || {}), [trustKey(root)]: providerHash(wallet.provider) } }));
}

function describeProvider(p) {
  return Object.entries(p).map(([k, v]) => `  ${k}: ${v}`).join('\n');
}

async function trust(root, wallet, { ask: interactive = true } = {}) {
  if (isTrusted(root, wallet)) return;
  if (!interactive) throw new ExitError(`This machine has not confirmed the wallet provider yet. Run ${cmd('kette wallet trust')} in a terminal first (CI: ${TRUST_ENV}=1).`, 1);
  console.log(`${WALLET_PATH} asks this machine to use:\n${describeProvider(wallet.provider)}`);
  if (wallet.provider.id === 'command') console.log(dim('These commands run on your machine with your rights. Only confirm commands you have read.'));
  let yes;
  try { yes = await confirm('Use this provider on this machine?'); } catch (err) {
    if (err.message === NO_TERMINAL) throw new ExitError(`No terminal to confirm the wallet provider. Run ${cmd('kette wallet trust')} in a terminal (CI: ${TRUST_ENV}=1).`, 1);
    throw err;
  }
  if (!yes) throw new ExitError('Not confirmed, nothing changed.', 1);
  remember(root, wallet);
}

async function readValues(provider, env, names) {
  try { return await provider.read(env, names); } catch (err) { throw asExit(err); }
}
const asExit = (err) => (err instanceof ProviderError ? new ExitError(err.message, 1) : err);

async function providerSettings(id, root, project) {
  if (id === 'infisical') return setupInfisical(root);
  if (id === 'vault') {
    const address = await ask('Vault address (empty uses VAULT_ADDR)', '');
    const mount = await ask('KV version 2 mount', 'secret');
    const p = await ask('Path inside the mount, one entry per environment below it', `apps/${project}`);
    return { id, ...(address ? { address } : {}), mount, path: p };
  }
  if (id === 'aws-secrets-manager') {
    const prefix = await ask('Secret name prefix, one secret per environment below it', project);
    const region = await ask('AWS region (empty uses your AWS profile)', '');
    return { id, prefix, ...(region ? { region } : {}) };
  }
  if (id === 'azure-key-vault') {
    const vault = await ask('Key Vault name');
    if (!vault) throw new ExitError('The Key Vault name is needed.', 1);
    return { id, vault };
  }
  console.log(dim('{env} and {name} are filled in. read prints the value, write takes it on stdin. Example 1Password:\n  read:  op read "op://{env}/{name}/credential"\n  write: op item edit {name} --vault {env} "credential[password]=$(cat)"'));
  const read = await ask('Command that prints one value');
  const write = await ask('Command that stores one value from stdin');
  if (!read || !write) throw new ExitError('Both commands are needed for your own wallet.', 1);
  return { id, read, write };
}

// Non-interactive provider from options: --provider infisical needs KETTE_WALLET_PROJECT and so on, kept small on purpose
function providerFromEnv(id, project, root, inherited = null) {
  const e = process.env;
  if (id === 'infisical') return { id, project: e.KETTE_WALLET_PROJECT || (inherited?.provider === id && inherited.project) || linkedProject(root) || '', ...(e.KETTE_WALLET_DOMAIN ? { domain: e.KETTE_WALLET_DOMAIN } : {}) };
  if (id === 'vault') return { id, path: e.KETTE_WALLET_PATH || `apps/${project}` };
  if (id === 'aws-secrets-manager') return { id, prefix: e.KETTE_WALLET_PREFIX || project };
  if (id === 'azure-key-vault') return { id, vault: e.KETTE_WALLET_VAULT || '' };
  return { id, read: e.KETTE_WALLET_READ || '', write: e.KETTE_WALLET_WRITE || '' };
}

function readProfile(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, '.kette', 'profile.json'), 'utf8')); } catch { return null; }
}

// platform.secrets in the profile follows the wallet, so agents and templates see the same store
function syncProfile(root, providerId) {
  const f = path.join(root, '.kette', 'profile.json');
  const profile = readProfile(root);
  const value = PROFILE_SECRETS[providerId];
  if (!profile?.platform || !value || profile.platform.secrets === value) return false;
  profile.platform = { ...profile.platform, secrets: value };
  fs.writeFileSync(f, `${JSON.stringify(profile, null, 2)}\n`);
  return true;
}

// Wallet defaults of the instance the repo belongs to (provider, project, environment), null without one
function instanceWallet(profile) {
  if (!profile?.instance) return null;
  try { return readInstance(profile.instance)?.wallet || null; } catch { return null; }
}

async function init(root, opts) {
  if (fs.existsSync(walletFile(root))) throw new ExitError(`${WALLET_PATH} exists already. Change it by hand or with ${cmd('kette wallet add')}.`, 1);
  const profile = readProfile(root);
  const project = (profile?.project?.name || path.basename(path.resolve(root))).toLowerCase().replace(/[^a-z0-9-]+/g, '-');
  const inherited = instanceWallet(profile);
  let id = opts.provider || inherited?.provider || DEFAULT_PROVIDER;
  if (!PROVIDER_IDS.includes(id)) throw new ExitError(`--provider must be one of ${PROVIDER_IDS.join(', ')}`);
  if (inherited && !opts.provider) console.log(dim(`Provider ${id} from instance ${profile.instance}.`));
  else if (!opts.yes && !opts.provider) [id] = await choose('Where do the secrets live?', PROVIDERS, '1');
  const provider = opts.yes ? providerFromEnv(id, project, root, inherited) : await providerSettings(id, root, project);
  const defaults = inherited?.env && !DEFAULT_ENVIRONMENTS.includes(inherited.env) ? [inherited.env, ...DEFAULT_ENVIRONMENTS] : DEFAULT_ENVIRONMENTS;
  const environments = list(opts.env) || (opts.yes ? defaults : list(await ask('Environments', defaults.join(','))));
  const folders = Object.values(profile?.apps || {}).filter((v) => typeof v === 'string');
  const names = exampleNames(root, folders);
  const wallet = newWallet(provider, environments, names);
  if (opts.dryRun) {
    console.log(JSON.stringify(wallet, null, 2));
    return 0;
  }
  writeWallet(root, wallet);
  remember(root, wallet);
  line('ok', `${file(WALLET_PATH)} written ${dim(`(${id}, ${environments.join(', ')}, ${names.length} name${names.length === 1 ? '' : 's'}${names.length ? ' from .env.example' : ''})`)}`);
  if (syncProfile(root, id)) line('ok', `.kette/profile.json: platform.secrets set to ${id}`);
  if (!providerVersion(provider)) line('warn', `${providerFor(provider).bin} not found on this machine, ${cmd('kette wallet status')} explains how to install it`);
  else checkEnvironments(wallet);
  const local = ['.env', '.env.local'].find((f) => fs.existsSync(path.join(root, f)));
  console.log(`\nNext: ${local ? `${cmd(`kette wallet import ${local} --env dev`)} moves the values of ${local} into the wallet, ` : ''}${cmd('kette wallet status')} shows what is missing, ${cmd('kette wallet set NAME --env dev')} stores a value, ${cmd('kette wallet run --env dev -- <command>')} starts with them.`);
  console.log(dim('Commit .kette/wallet.json. It holds names only, the values stay in the provider.'));
  console.log(dim(OWNERSHIP));
  return 0;
}

// Every environment once against the provider, so a missing environment or folder shows up now and not at the first run
function checkEnvironments(wallet) {
  const provider = providerFor(wallet.provider);
  for (const env of wallet.environments) {
    try {
      provider.read(env, []);
      line('ok', `${env} reachable ${dim(`(${provider.where(env)})`)}`);
    } catch (err) {
      const hint = /environment|folder|not found/i.test(err.message) ? ' Create it in the provider (Infisical: Project settings, Environments) or remove it from environments in .kette/wallet.json.' : '';
      line('warn', `${env}: ${err.message}.${hint}`);
    }
  }
}

// Values of a .env file into the wallet: undeclared names are declared, nothing is printed but names, the file can go afterwards
async function importCmd(root, wallet, file, opts) {
  if (!file) throw new ExitError('Usage: kette wallet import <file> --env <env>');
  const env = checkEnv(wallet, opts.env);
  const target = path.resolve(root, file);
  if (!fs.existsSync(target)) throw new ExitError(`${file} not found`, 1);
  const entries = [...parseDotenv(fs.readFileSync(target, 'utf8'))];
  const bad = entries.filter(([k]) => !NAME_PATTERN.test(k)).map(([k]) => k);
  const empty = entries.filter(([k, v]) => NAME_PATTERN.test(k) && v === '').map(([k]) => k);
  const values = entries.filter(([k, v]) => NAME_PATTERN.test(k) && v !== '');
  if (bad.length) line('warn', `Skipped, not an environment variable name: ${bad.join(', ')}`);
  if (empty.length) line('info', `Skipped, empty: ${empty.join(', ')}`);
  if (!values.length) { line('info', `No values to import from ${file}.`); return 0; }
  const declared = new Set(namesFor(wallet, env));
  const fresh = values.map(([k]) => k).filter((k) => !wallet.secrets.some((s) => s.name === k));
  const blocked = values.map(([k]) => k).filter((k) => !declared.has(k) && !fresh.includes(k));
  if (blocked.length) throw new ExitError(`Declared for other environments only: ${blocked.join(', ')}. Add ${env} to them in ${WALLET_PATH} first.`, 1);
  const provider = providerFor(wallet.provider);
  console.log(`Imports ${values.length} value${values.length === 1 ? '' : 's'} from ${file} into ${provider.where(env)}:\n  ${values.map(([k]) => k).join(', ')}`);
  if (fresh.length) console.log(`Not declared yet, ${WALLET_PATH} gets: ${fresh.join(', ')}`);
  if (opts.dryRun) { console.log(dim('--dry-run: nothing imported.')); return 0; }
  if (!(await confirm('Import now? Existing values with the same name are replaced.', opts.yes))) throw new ExitError('Not confirmed, nothing imported.', 1);
  await trust(root, wallet);
  if (fresh.length) writeWallet(root, { ...wallet, secrets: [...wallet.secrets, ...fresh.map((name) => ({ name }))] });
  for (const [name, value] of values) {
    try { await provider.write(env, name, value); } catch (err) { throw asExit(err); }
    line('ok', name);
  }
  const tracked = spawnSync('git', ['ls-files', '--error-unmatch', file], { cwd: root, encoding: 'utf8' }).status === 0;
  if (tracked) line('warn', `${file} is in git. Remove it from the repo and rotate these values, the history still holds them.`);
  if (!opts.yes && process.stdin.isTTY && (await confirm(`Delete ${file} now? The values are in the wallet.`))) {
    fs.rmSync(target);
    line('ok', `${file} deleted. Start with ${cmd(`kette wallet run --env ${env} -- <command>`)}`);
  } else console.log(`Delete ${file} once everything starts with ${cmd(`kette wallet run --env ${env} -- <command>`)}`);
  return 0;
}

async function statusCmd(root, wallet, opts) {
  const provider = providerFor(wallet.provider);
  const version = providerVersion(wallet.provider);
  line(version ? 'ok' : 'fail', version ? `${provider.bin} found ${dim(`(${version})`)}` : `${provider.bin} not found`);
  if (!version) {
    console.log(`  ${installHint(provider.bin)}`);
    return 1;
  }
  await trust(root, wallet, { ask: !opts.yes && process.stdin.isTTY });
  const envs = opts.env ? [checkEnv(wallet, opts.env)] : wallet.environments;
  let missing = 0;
  for (const env of envs) {
    const names = namesFor(wallet, env, opts.app);
    let values;
    try { values = await provider.read(env, names); } catch (err) { line('fail', asExit(err).message); missing += names.length || 1; continue; }
    const absent = names.filter((n) => !values.has(n) || values.get(n) === '');
    missing += absent.length;
    if (absent.length) line('fail', `${env}: ${names.length - absent.length} of ${names.length} set, missing ${absent.join(', ')} ${dim(`(${provider.where(env)})`)}`);
    else line('ok', `${env}: all ${names.length} set ${dim(`(${provider.where(env)})`)}`);
  }
  if (missing) console.log(`\nSet a value with ${cmd('kette wallet set NAME --env <env>')}`);
  return missing ? 1 : 0;
}

async function readValue(name, env, opts) {
  if (opts.stdin) {
    const value = fs.readFileSync(0, 'utf8').replace(/\r?\n$/, '');
    if (!value) throw new ExitError('stdin was empty, nothing stored.', 1);
    return value;
  }
  const value = await askSecret(`Value for ${name} in ${env} (input hidden)`, `No terminal for the hidden prompt. Pipe the value in: kette wallet set ${name} --env ${env} --stdin`);
  if (!value) throw new ExitError('Empty value, nothing stored.', 1);
  return value;
}

async function setCmd(root, wallet, name, opts) {
  checkName(name);
  const env = checkEnv(wallet, opts.env);
  if (!namesFor(wallet, env).includes(name)) throw new ExitError(`${name} is not declared for ${env}. Declare it first: ${cmd(`kette wallet add ${name} --env ${env}`)}`, 1);
  await trust(root, wallet);
  const provider = providerFor(wallet.provider);
  const value = await readValue(name, env, opts);
  try { await provider.write(env, name, value); } catch (err) { throw asExit(err); }
  line('ok', `${name} stored in ${provider.where(env)}`);
  return 0;
}

async function addCmd(root, wallet, name, opts) {
  checkName(name);
  if (wallet.secrets.some((s) => s.name === name)) throw new ExitError(`${name} is declared already in ${WALLET_PATH}`, 1);
  const envs = list(opts.env);
  for (const e of envs || []) checkEnv(wallet, e);
  const entry = { name, ...(envs ? { environments: envs } : {}), ...(opts.app ? { apps: list(opts.app) } : {}), ...(opts.note ? { note: opts.note } : {}) };
  writeWallet(root, { ...wallet, secrets: [...wallet.secrets, entry] });
  line('ok', `${name} declared in ${file(WALLET_PATH)}`);
  if (opts.yes || opts.stdin || !process.stdin.isTTY) {
    console.log(`Store the value with ${cmd(`kette wallet set ${name} --env <env>`)}`);
    return 0;
  }
  const next = readWallet(root);
  for (const env of envs || next.environments) {
    if (!(await confirm(`Set the value for ${env} now?`))) continue;
    await setCmd(root, next, name, { ...opts, env });
  }
  return 0;
}

function removeCmd(root, wallet, name) {
  checkName(name);
  if (!wallet.secrets.some((s) => s.name === name)) throw new ExitError(`${name} is not declared in ${WALLET_PATH}`, 1);
  writeWallet(root, { ...wallet, secrets: wallet.secrets.filter((s) => s.name !== name) });
  line('ok', `${name} removed from ${file(WALLET_PATH)}. The value stays in the provider, delete it there if nothing needs it any more.`);
  return 0;
}

async function runCmd(root, wallet, opts) {
  const env = checkEnv(wallet, opts.env);
  const [bin, ...args] = opts.rest || [];
  if (!bin) throw new ExitError('Usage: kette wallet run --env <env> [--app name] -- <command> [args]');
  await trust(root, wallet, { ask: process.stdin.isTTY });
  const names = namesFor(wallet, env, opts.app);
  const values = await readValues(providerFor(wallet.provider), env, names);
  const absent = names.filter((n) => !values.has(n));
  if (absent.length) throw new ExitError(`Missing in ${env}: ${absent.join(', ')}. Set them with ${cmd(`kette wallet set NAME --env ${env}`)}`, 1);
  const secrets = Object.fromEntries(names.map((n) => [n, values.get(n)]));
  const spawnOpts = { stdio: 'inherit', env: { ...process.env, ...secrets } };
  let r = spawnSync(bin, args, spawnOpts);
  // npm, npx and other .cmd shims on Windows only start through cmd.exe, with the same safety rules as claude.cmd
  if (r.error?.code === 'ENOENT' && process.platform === 'win32') {
    const line = cmdLine(args, `${bin}.cmd`);
    if (line) r = spawnSync(line, { ...spawnOpts, shell: true });
  }
  if (r.error) throw new ExitError(`${bin} could not start: ${r.error.code || r.error.message}`, 127);
  return r.status ?? 1;
}

async function syncGithub(root, wallet, opts) {
  const env = checkEnv(wallet, opts.env);
  const target = opts['github-env'] || env;
  const names = namesFor(wallet, env, opts.app);
  if (!names.length) { line('info', `No secrets declared for ${env}.`); return 0; }
  const repo = opts.repo ? ['--repo', opts.repo] : [];
  const where = `GitHub environment ${bold(target)}${opts.repo ? ` of ${opts.repo}` : ' of this repo'}`;
  console.log(`Copies ${names.length} secret${names.length === 1 ? '' : 's'} from ${env} into ${where}:\n  ${names.join(', ')}`);
  if (opts.dryRun) { console.log(dim('--dry-run: nothing copied.')); return 0; }
  await trust(root, wallet);
  if (!(await confirm('Copy now? Existing values with the same name are replaced.', opts.yes))) throw new ExitError('Not confirmed, nothing copied.', 1);
  const values = await readValues(providerFor(wallet.provider), env, names);
  const absent = names.filter((n) => !values.has(n));
  if (absent.length) throw new ExitError(`Missing in ${env}: ${absent.join(', ')}. Nothing copied.`, 1);
  for (const name of names) {
    // gh reads the value from stdin when --body is not given
    const r = spawnTool('gh', ['secret', 'set', name, '--env', target, ...repo], { input: values.get(name) });
    if (r.error?.code === 'ENOENT') throw new ExitError('gh not found. Install the GitHub CLI and sign in with gh auth login.', 1);
    if (r.status !== 0) throw new ExitError(`gh secret set ${name} failed: ${(r.stderr || '').trim().split('\n')[0]}`, 1);
    line('ok', `${name} → ${target}`);
  }
  return 0;
}

export const hasWallet = (root) => fs.existsSync(walletFile(root));

// Offer after kette init and kette add (Enterprise, terminal, no wallet yet); a failure here never fails the setup
export async function offerWallet(root, opts, tier) {
  if (tier !== ENTERPRISE || opts.yes || opts.dryRun || hasWallet(root) || !process.stdin.isTTY) return;
  if (!(await confirm('\nSet up the secret wallet for credentials now? (Infisical by default, names in the repo, values never)'))) return;
  try {
    await wallet('init', { ...opts, provider: undefined }, { tier, root });
  } catch (err) {
    if (!(err instanceof ExitError)) throw err;
    console.log(`${status('warn', 'WARN')} ${err.message} Later with: ${cmd('kette wallet init')}`);
  }
}

export async function wallet(sub, opts, { tier, root = '.' }) {
  if (!sub || sub === 'help') { console.log(`Secret wallet (Enterprise): names in ${WALLET_PATH}, values in your provider.\n${OWNERSHIP}\n\n  ${WALLET_HELP}`); return 0; }
  requireEnterprise(tier);
  if (sub === 'init') return await init(root, opts);
  const w = requireWallet(root);
  const [, , name] = opts._;
  if (sub === 'status') return await statusCmd(root, w, opts);
  if (sub === 'trust') { await trust(root, w); line('ok', 'Provider confirmed on this machine.'); return 0; }
  if (sub === 'add') return await addCmd(root, w, name, opts);
  if (sub === 'set') return await setCmd(root, w, name, opts);
  if (sub === 'remove') return removeCmd(root, w, name);
  if (sub === 'import') return await importCmd(root, w, name, opts);
  if (sub === 'run') return await runCmd(root, w, opts);
  if (sub === 'sync') {
    if (name !== 'github') throw new ExitError('Usage: kette wallet sync github --env <env> [--github-env name] [--repo owner/name]');
    return await syncGithub(root, w, opts);
  }
  throw new ExitError(`Unknown wallet command: ${sub}. See ${cmd('kette wallet help')}`);
}

// One line for kette doctor; never reads a value, only whether the wallet file is valid and confirmed here
export function walletDoctor(root, tier, { line: check, warn, info }, { project = false } = {}) {
  if (!fs.existsSync(walletFile(root))) {
    if (tier === ENTERPRISE && project) info(`No secret wallet in this project yet. Credentials per environment, Infisical by default: ${cmd('kette wallet init')}`);
    return;
  }
  let w;
  try { w = readWallet(root); } catch (err) { check(false, '', err.message); return; }
  check(true, `Secret wallet ${dim(`(${w.provider.id}, ${w.secrets.length} name${w.secrets.length === 1 ? '' : 's'}, ${w.environments.join(', ')})`)}`);
  if (tier !== ENTERPRISE) { warn(`The project uses the secret wallet, it needs Enterprise (Die Kette): ${cmd('kette login <key>')}`); return; }
  if (!isTrusted(root, w)) info(`Wallet provider not confirmed on this machine yet: ${cmd('kette wallet trust')}`);
  else info(`Missing values per environment: ${cmd('kette wallet status')}`);
}
