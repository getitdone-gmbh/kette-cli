import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { instancesDir } from '../paths.mjs';
import { COMMUNITY, ENTERPRISE } from '../editions.mjs';
import { readState, validVersion, writeState } from '../manifest.mjs';
import { ENV_PATTERN, PROVIDER_IDS } from '../wallet/config.mjs';

// instance.json describes one Kette instance: edition, repos, members and the shared settings its repos inherit
export const INSTANCE_FILE = 'instance.json';
export const SCHEMA_URL = 'https://kette.itdone.de/schema/instance.schema.json';
export const EDITIONS = [COMMUNITY, ENTERPRISE];
export const ROLES = ['owner', 'member'];
// A name becomes a folder under ~/.kette/instances, so only lowercase letters, digits and dashes
export const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
const REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const TEXT_MAX = 200;
const FIELDS = ['$schema', 'version', 'name', 'edition', 'bundle', 'repos', 'members', 'ticketing', 'wallet', 'overlays', 'stations'];

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.trim().length > 0 && v.length <= TEXT_MAX && !/[\r\n]/.test(v);
const unknown = (obj, allowed, at) => Object.keys(obj).filter((k) => !allowed.includes(k)).map((k) => `unknown field ${at}${k}`);

export const validName = (name) => typeof name === 'string' && NAME_PATTERN.test(name);
export const instanceDir = (name) => path.join(instancesDir(), name);
export const instanceFile = (name) => path.join(instanceDir(name), INSTANCE_FILE);

// Entries of a list field, each checked by check(entry, at) which returns its errors; key(entry) must be unique
function listErrors(value, field, check, key) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return [`${field} must be a list`];
  const seen = new Set();
  return value.flatMap((entry, i) => {
    const at = `${field}[${i}]`;
    const errs = check(entry, at);
    if (errs.length) return errs;
    if (seen.has(key(entry))) return [`${at} ${key(entry)} is listed twice`];
    seen.add(key(entry));
    return [];
  });
}

const repoErrors = (r, at) => {
  if (!isObject(r)) return [`${at} must be an object`];
  const errs = unknown(r, ['name', 'url'], `${at}.`);
  if (typeof r.name !== 'string' || !REPO_PATTERN.test(r.name)) errs.push(`${at}.name must be a folder name (letters, digits, . _ -)`);
  if ('url' in r && !isText(r.url)) errs.push(`${at}.url must be one line`);
  return errs;
};

const memberErrors = (m, at) => {
  if (!isObject(m)) return [`${at} must be an object`];
  const errs = unknown(m, ['id', 'role'], `${at}.`);
  if (!isText(m.id)) errs.push(`${at}.id must be one line (an email address or a handle)`);
  if (!ROLES.includes(m.role)) errs.push(`${at}.role must be ${ROLES.join(' or ')}`);
  return errs;
};

function sectionErrors(i) {
  const errs = [];
  if ('ticketing' in i) {
    const t = i.ticketing;
    if (!isObject(t)) errs.push('ticketing must be an object');
    else {
      errs.push(...unknown(t, ['adapter', 'project'], 'ticketing.'));
      if (typeof t.adapter !== 'string' || !ID_PATTERN.test(t.adapter)) errs.push('ticketing.adapter must be an adapter id (lowercase letters, digits, dashes)');
      if (!isText(t.project)) errs.push('ticketing.project must be one line');
    }
  }
  if ('wallet' in i) {
    const w = i.wallet;
    if (!isObject(w)) errs.push('wallet must be an object');
    else {
      errs.push(...unknown(w, ['provider', 'project', 'env'], 'wallet.'));
      if (!PROVIDER_IDS.includes(w.provider)) errs.push(`wallet.provider must be one of ${PROVIDER_IDS.join(', ')}`);
      if ('project' in w && !isText(w.project)) errs.push('wallet.project must be one line');
      if ('env' in w && (typeof w.env !== 'string' || !ENV_PATTERN.test(w.env))) errs.push('wallet.env must be an environment name (lowercase letters, digits, dashes)');
    }
  }
  errs.push(...listErrors(i.overlays, 'overlays', (o, at) => (isObject(o) && isText(o.source) && !unknown(o, ['source'], '').length ? [] : [`${at} must be an object with source`]), (o) => o.source));
  errs.push(...listErrors(i.stations, 'stations', (s, at) => (typeof s === 'string' && ID_PATTERN.test(s) ? [] : [`${at} must be a station id (lowercase letters, digits, dashes)`]), (s) => s));
  return errs;
}

// Errors as "field: problem"; an empty list means valid
export function validateInstance(i) {
  if (!isObject(i)) return ['the instance must be a JSON object'];
  const errs = unknown(i, FIELDS, '');
  if (i.version !== 1) errs.push('version must be 1');
  if (!validName(i.name)) errs.push('name must be lowercase letters, digits and dashes');
  if (!EDITIONS.includes(i.edition)) errs.push(`edition must be ${EDITIONS.join(' or ')}`);
  if ('bundle' in i && !validVersion(i.bundle)) errs.push('bundle must be a bundle version, e.g. 0.20261025.92');
  errs.push(...listErrors(i.repos, 'repos', repoErrors, (r) => r.name));
  errs.push(...listErrors(i.members, 'members', memberErrors, (m) => m.id.toLowerCase()));
  errs.push(...sectionErrors(i));
  return errs;
}

export function newInstance(name, edition) {
  return { $schema: SCHEMA_URL, version: 1, name, edition, repos: [], members: [] };
}

// null when the instance does not exist; a damaged file throws with the reason
export function readInstance(name) {
  if (!validName(name)) throw new Error(`Invalid instance name ${JSON.stringify(name)}. Use lowercase letters, digits and dashes.`);
  const f = instanceFile(name);
  if (!fs.existsSync(f)) return null;
  let instance;
  try { instance = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (err) { throw new Error(`${f} is not valid JSON: ${err.message}`); }
  const errs = validateInstance(instance);
  if (errs.length) throw new Error(`${f} is not valid: ${errs.join('; ')}`);
  if (instance.name !== name) throw new Error(`${f} names the instance "${instance.name}", its folder is "${name}". Use the same name for both.`);
  return instance;
}

export function writeInstance(instance) {
  const errs = validateInstance(instance);
  if (errs.length) throw new Error(`Instance not valid: ${errs.join('; ')}`);
  fs.mkdirSync(instanceDir(instance.name), { recursive: true });
  fs.writeFileSync(instanceFile(instance.name), `${JSON.stringify(instance, null, 2)}\n`);
}

export function listInstances() {
  if (!fs.existsSync(instancesDir())) return [];
  return fs.readdirSync(instancesDir()).filter((n) => validName(n) && fs.existsSync(instanceFile(n))).sort();
}

// local: a plain folder; clone: a git checkout of an instance repo; link: a link to an instance repo elsewhere
export function instanceSource(name) {
  const dir = instanceDir(name);
  if (fs.lstatSync(dir).isSymbolicLink()) return { kind: 'link', path: fs.realpathSync(dir) };
  if (fs.existsSync(path.join(dir, '.git'))) return { kind: 'clone', path: dir };
  return { kind: 'local', path: dir };
}

// Local checkouts of instance repos live in state.json, never in instance.json: paths differ per machine
export const checkouts = (name) => readState().instances?.[name]?.checkouts || {};

export function setCheckout(name, repo, dir) {
  const all = readState().instances || {};
  const entry = all[name] || {};
  writeState({ instances: { ...all, [name]: { ...entry, checkouts: { ...entry.checkouts, [repo]: dir } } } });
}

export function dropCheckout(name, repo) {
  const all = readState().instances || {};
  const { [repo]: _gone, ...rest } = all[name]?.checkouts || {};
  writeState({ instances: { ...all, [name]: { ...all[name], checkouts: rest } } });
}

export function forgetInstance(name) {
  const all = { ...readState().instances };
  delete all[name];
  writeState({ instances: all });
}

// Name and origin URL of a repo folder; the URL is what other machines match a checkout by
export function repoIdentity(dir) {
  const abs = fs.realpathSync(dir);
  const r = spawnSync('git', ['-C', abs, 'remote', 'get-url', 'origin'], { encoding: 'utf8' });
  const url = r.status === 0 ? r.stdout.trim() : '';
  return { name: path.basename(abs).replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[^A-Za-z0-9]+/, '') || 'repo', url: url || null, path: abs };
}

// Adds the repo to the instance unless it is there already (same URL, or same name without URL); a name taken by another URL is refused
export function withRepo(instance, { name, url }) {
  const repos = instance.repos || [];
  const same = repos.find((r) => (url && r.url === url) || (!url && !r.url && r.name === name));
  if (same) return { instance, repo: same, added: false };
  if (repos.some((r) => r.name === name)) throw new Error(`Instance ${instance.name} already has a repo named ${name} with another origin. Rename the folder or remove the entry from ${INSTANCE_FILE}.`);
  const repo = url ? { name, url } : { name };
  return { instance: { ...instance, repos: [...repos, repo] }, repo, added: true };
}

// Effective project settings: the instance gives edition and shared settings, values the repo sets itself win
export function inherit(profile, instance) {
  if (!instance) return profile;
  const shared = Object.fromEntries(['ticketing', 'wallet', 'overlays', 'stations', 'bundle'].filter((k) => k in instance).map((k) => [k, instance[k]]));
  return { ...shared, ...profile, tier: instance.edition, instance: instance.name };
}
