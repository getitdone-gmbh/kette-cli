import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { instancesDir } from '../paths.mjs';
import { COMMUNITY, ENTERPRISE } from '../editions.mjs';
import { readState, updateState, validVersion } from '../manifest.mjs';
import { writeAtomic } from '../files.mjs';
import { withLock } from '../lock.mjs';
import { ENV_PATTERN, PROVIDER_IDS } from '../wallet/config.mjs';

// instance.json describes one Kette instance: edition, repos, members and the shared settings its repos inherit
export const INSTANCE_FILE = 'instance.json';
export const SCHEMA_URL = 'https://kette.itdone.de/schema/instance.schema.json';
export const EDITIONS = [COMMUNITY, ENTERPRISE];
export const ROLES = ['owner', 'member'];
// A name becomes a folder under ~/.kette/instances, so only lowercase letters, digits and dashes, and no name Windows reserves
export const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
const REPO_MAX = 100;
const REPO_PATTERN = new RegExp(`^[A-Za-z0-9][A-Za-z0-9._-]{0,${REPO_MAX - 1}}$`);
const TEXT_MAX = 200;
const FIELDS = ['$schema', 'version', 'name', 'edition', 'bundle', 'repos', 'members', 'ticketing', 'wallet', 'overlays', 'stations'];

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const isText = (v) => typeof v === 'string' && v.trim().length > 0 && v.length <= TEXT_MAX && !CONTROL.test(v);
const unknown = (obj, allowed, at) => Object.keys(obj).filter((k) => !allowed.includes(k)).map((k) => `unknown field ${at}${k}`);

export const validName = (name) => typeof name === 'string' && NAME_PATTERN.test(name) && !RESERVED.test(name);
export const instanceDir = (name) => path.join(instancesDir(), name);
export const instanceFile = (name) => path.join(instanceDir(name), INSTANCE_FILE);

// Text from instance.json, git or a profile before it is printed: no escape sequences, no control characters
export const printable = (s) => String(s).replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
// User info in a URL (a token or a password) never reaches the screen
export const redact = (s) => printable(s).replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, '$1');

const SCP = /^(?:([^@/\s]+)@)?([^:/\s]+):(?!\/\/)(.+)$/;
const trimPath = (p) => p.replace(/\/+$/, '').replace(/\.git$/, '').replace(/^\/+/, '');

// Origin of a repo in two forms: url to store and show (no user info), key to compare (ssh, https and scp forms of a repo are equal)
export function normalizeUrl(raw) {
  const text = String(raw).trim();
  const scp = !/^[a-z][a-z0-9+.-]*:\/\//i.test(text) && !/^[a-z]:[\\/]/i.test(text) && text.match(SCP);
  if (scp) {
    const [, user, host, rest] = scp;
    const h = host.toLowerCase();
    return { url: `${user === 'git' ? 'git@' : ''}${h}:${rest}`, key: `${h}/${trimPath(rest)}` };
  }
  let u;
  // A Windows drive path (C:/repos/app.git) would parse as a URL with the scheme c:
  try { u = /^[a-z]:[\\/]/i.test(text) ? null : new URL(text); } catch { u = null; }
  if (!u || u.protocol === 'file:') {
    const local = path.resolve(u ? decodeURIComponent(u.pathname) : text);
    return { url: local, key: `path:${trimPath(local.split(path.sep).join('/'))}` };
  }
  // The ssh user git is no secret and needed to clone; any other user info is dropped
  const keepGit = u.protocol === 'ssh:' && u.username === 'git' && !u.password;
  u.username = keepGit ? 'git' : '';
  u.password = '';
  u.hash = '';
  u.search = '';
  const host = u.host.toLowerCase();
  const p = trimPath(decodeURIComponent(u.pathname));
  return { url: `${u.protocol}//${keepGit ? 'git@' : ''}${host}/${p}`, key: `${host.replace(/:\d+$/, '')}/${p}` };
}

const repoKey = (r) => (r.url ? normalizeUrl(r.url).key : null);
// A repo without origin is identified in instance.json by a hash of its local identity: no machine path reaches the shared file,
// and the entry is found again without state.json, so a kette killed between the two writes cannot put it into two instances (QA-29)
const LOCAL_ID = /^[0-9a-f]{24}$/;
export const localId = (key) => crypto.createHash('sha256').update(key).digest('hex').slice(0, 24);

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
  const errs = unknown(r, ['name', 'url', 'local'], `${at}.`);
  if ('local' in r && (typeof r.local !== 'string' || !LOCAL_ID.test(r.local))) errs.push(`${at}.local must be the identity hash kette wrote`);
  if (typeof r.name !== 'string' || !REPO_PATTERN.test(r.name)) errs.push(`${at}.name must be a folder name (letters, digits, . _ -, at most ${REPO_MAX})`);
  if ('url' in r && !isText(r.url)) errs.push(`${at}.url must be one line`);
  else if ('url' in r && /^[a-z][a-z0-9+.-]*:\/\/[^/\s]*@/i.test(r.url)) errs.push(`${at}.url must not hold user info (a token or password)`);
  return errs;
};

const memberErrors = (m, at) => {
  if (!isObject(m)) return [`${at} must be an object`];
  const errs = unknown(m, ['id', 'role'], `${at}.`);
  if (!isText(m.id)) errs.push(`${at}.id must be one line (an email address or a handle)`);
  if (!ROLES.includes(m.role)) errs.push(`${at}.role must be ${ROLES.join(' or ')}`);
  return errs;
};

const DONE_MAX = 1000;
const TARGETS_MAX = 50;
const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];
const v4Private = (ip) => {
  const p = ip.split('.').map(Number);
  return p.length === 4 && p.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) && (p[0] === 10 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) || (p[0] === 169 && p[1] === 254));
};
// Private, link-local and unique-local addresses, also IPv4-mapped IPv6 (KETTE-38); names that resolve to them are refused by the hook
export function isPrivateAddress(raw) {
  const ip = String(raw).replace(/^\[|\]$/g, '').toLowerCase();
  if (v4Private(ip)) return true;
  if (!ip.includes(':')) return false;
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (dotted) return v4Private(dotted[1]);
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip);
  if (hex) { const n = parseInt(hex[1], 16) * 65536 + parseInt(hex[2], 16); return v4Private([Math.floor(n / 16777216), Math.floor(n / 65536) % 256, Math.floor(n / 256) % 256, n % 256].join('.')); }
  const first = parseInt(ip.split(':')[0] || '0', 16);
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
}
// A model the intake hook may ask: https, http only on this machine, never a private, link-local or unique-local address
export function isModelUrl(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  const host = u.hostname.toLowerCase();
  if (LOOPBACK.includes(host)) return u.protocol === 'https:' || u.protocol === 'http:';
  return u.protocol === 'https:' && !isPrivateAddress(host);
}

// A board project id is one URL path segment (KETTE-28)
export const PROJECT_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
// A station is its id, or an object with the id and the definition of done this instance sets for it (KETTE-24)
export const stationId = (s) => (isObject(s) ? s.id : s);
function stationErrors(s, at) {
  const bad = [`${at} must be a station id (lowercase letters, digits, dashes) or an object with id and definitionOfDone`];
  if (typeof s === 'string') return ID_PATTERN.test(s) ? [] : bad;
  if (!isObject(s) || typeof s.id !== 'string' || !ID_PATTERN.test(s.id)) return bad;
  const errs = unknown(s, ['id', 'definitionOfDone', 'owner', 'builder', 'approve', 'merge', 'targets'], `${at}.`);
  const done = s.definitionOfDone;
  if ('definitionOfDone' in s && (typeof done !== 'string' || !done.trim() || done.length > DONE_MAX || CONTROL.test(done))) errs.push(`${at}.definitionOfDone must be one line of at most ${DONE_MAX} characters`);
  for (const k of ['owner', 'builder', 'approve', 'merge']) if (k in s && !isText(s[k])) errs.push(`${at}.${k} must be one line (a member, session or agent id)`);
  if ('targets' in s && (!Array.isArray(s.targets) || !s.targets.length || s.targets.length > TARGETS_MAX || s.targets.some((x) => !isText(x)) || new Set(s.targets).size !== s.targets.length)) errs.push(`${at}.targets must be a list of distinct names (repos, Figma files), at most ${TARGETS_MAX}`);
  return errs;
}

function sectionErrors(i) {
  const errs = [];
  if ('ticketing' in i) {
    const t = i.ticketing;
    if (!isObject(t)) errs.push('ticketing must be an object');
    else {
      errs.push(...unknown(t, ['adapter', 'project', 'session', 'intakeModel'], 'ticketing.'));
      if (typeof t.adapter !== 'string' || !ID_PATTERN.test(t.adapter)) errs.push('ticketing.adapter must be an adapter id (lowercase letters, digits, dashes)');
      if (typeof t.project !== 'string' || !PROJECT_PATTERN.test(t.project)) errs.push('ticketing.project must be a board project id (letters, digits, dash, underscore, at most 64)');
      if ('session' in t && typeof t.session !== 'boolean') errs.push('ticketing.session must be true or false (true allows the shared Workbase session file)');
      if ('intakeModel' in t && (!isText(t.intakeModel) || !isModelUrl(t.intakeModel))) errs.push('ticketing.intakeModel must be an https URL outside private, link-local and unique-local networks (http only on this machine)');
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
  errs.push(...listErrors(i.stations, 'stations', stationErrors, stationId));
  return errs;
}

// Errors as "field: problem"; an empty list means valid
export function validateInstance(i) {
  if (!isObject(i)) return ['the instance must be a JSON object'];
  const errs = unknown(i, FIELDS, '');
  if (i.version !== 1) errs.push('version must be 1');
  if (!validName(i.name)) errs.push('name must be lowercase letters, digits and dashes, and no name Windows reserves');
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

const nameError = (name) => new Error(`Invalid instance name ${JSON.stringify(printable(name))}. Use lowercase letters, digits and dashes.`);

// null when the instance does not exist; a damaged file throws with the reason
export function readInstance(name) {
  if (!validName(name)) throw nameError(name);
  const f = instanceFile(name);
  if (!fs.existsSync(f)) return null;
  let instance;
  try { instance = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (err) { throw new Error(`${f} is not valid JSON: ${err.message}`); }
  const errs = validateInstance(instance);
  if (errs.length) throw new Error(`${f} is not valid: ${errs.map(printable).join('; ')}`);
  if (instance.name !== name) throw new Error(`${f} names the instance "${printable(instance.name)}", its folder is "${name}". Use the same name for both.`);
  return instance;
}

function saveInstance(instance) {
  const errs = validateInstance(instance);
  if (errs.length) throw new Error(`Instance not valid: ${errs.join('; ')}`);
  writeAtomic(instanceFile(instance.name), `${JSON.stringify(instance, null, 2)}\n`);
}

export function writeInstance(instance) {
  withLock(`instance-${instance.name}`, () => saveInstance(instance));
}

// Read, change and write instance.json under its lock, so parallel kette processes never drop each other's changes
export function updateInstance(name, change) {
  return withLock(`instance-${name}`, () => {
    const current = readInstance(name);
    if (!current) throw new Error(`Instance ${name} not found on this machine.`);
    const next = change(current);
    if (next !== current) saveInstance(next);
    return next;
  });
}

// An instance folder, also a link whose target is gone
export const instanceExists = (name) => { try { fs.lstatSync(instanceDir(name)); return true; } catch { return false; } };

export function listInstances() {
  if (!fs.existsSync(instancesDir())) return [];
  return fs.readdirSync(instancesDir()).filter((n) => validName(n) && instanceExists(n)).sort();
}

// local: a plain folder; clone: a git checkout of an instance repo; link: a link to an instance repo elsewhere (dangling when its target is gone)
export function instanceSource(name) {
  const dir = instanceDir(name);
  if (fs.lstatSync(dir).isSymbolicLink()) {
    const target = path.resolve(path.dirname(dir), fs.readlinkSync(dir));
    return { kind: 'link', path: target, dangling: !fs.existsSync(target) };
  }
  if (fs.existsSync(path.join(dir, '.git'))) return { kind: 'clone', path: dir };
  return { kind: 'local', path: dir };
}

// Local checkouts of an instance live in state.json, never in instance.json: path to { repo, key }, paths differ per machine
export const checkouts = (name) => readState().instances?.[name]?.checkouts || {};

const withCheckouts = (state, name, change) => {
  const all = state.instances || {};
  const entry = all[name] || {};
  return { ...state, instances: { ...all, [name]: { ...entry, checkouts: change(entry.checkouts || {}) } } };
};

export function setCheckout(name, dir, repo, key) {
  updateState((state) => withCheckouts(state, name, (c) => ({ ...c, [dir]: { repo, key } })));
}

export function dropCheckouts(name, keep) {
  updateState((state) => withCheckouts(state, name, (c) => Object.fromEntries(Object.entries(c).filter(([dir, v]) => keep(dir, v)))));
}

export function forgetInstance(name) {
  updateState((state) => {
    const { [name]: _gone, ...rest } = state.instances || {};
    return { ...state, instances: rest };
  });
}

const git = (dir, ...args) => {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return r.status === 0 ? r.stdout.trim() : '';
};

// A repo folder name for instance.json: unsafe characters become dashes, at most REPO_MAX, never a name Windows reserves
export function repoName(dir) {
  const base = path.basename(dir).replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, REPO_MAX) || 'repo';
  return RESERVED.test(base.split('.')[0]) ? `${base.slice(0, REPO_MAX - 5)}-repo` : base;
}

// Identity of a repo folder: its normalised origin; without origin the real path of its git common folder, so a worktree and its main
// checkout are one repo; a folder inside another repo or without git counts as its own repo (docs/adr/0002, decision 12)
export function repoIdentity(dir) {
  const abs = fs.realpathSync(dir);
  const top = git(abs, 'rev-parse', '--show-toplevel');
  // git prints forward slashes and Windows may use short 8.3 names, so both sides go through the native real path
  const own = Boolean(top) && fs.realpathSync.native(top) === fs.realpathSync.native(abs);
  const origin = own ? git(abs, 'remote', 'get-url', 'origin') : '';
  if (origin) {
    const { url, key } = normalizeUrl(origin);
    return { name: repoName(abs), url, key, path: abs };
  }
  const common = own ? git(abs, 'rev-parse', '--git-common-dir') : '';
  const gitDir = common ? path.resolve(abs, common) : path.join(abs, '.git');
  const real = fs.existsSync(gitDir) ? fs.realpathSync.native(gitDir) : path.join(fs.realpathSync.native(abs), '.git');
  return { name: repoName(abs), url: null, key: `local:${real.split(path.sep).join('/')}`, path: abs };
}

// The repo entry of an identity in an instance: by origin key, or for a repo without origin by a local checkout with the same key
function findRepo(instance, id, local) {
  if (id.url) return instance.repos.find((r) => repoKey(r) === id.key) || null;
  const hash = localId(id.key);
  const names = new Set(Object.values(local).filter((c) => c.key === id.key).map((c) => c.repo));
  return instance.repos.find((r) => !r.url && (r.local === hash || (!r.local && names.has(r.name)))) || null;
}

// A free name: the folder name, or with -2, -3 when another repo has it already
function freeName(instance, name) {
  const taken = new Set(instance.repos.map((r) => r.name));
  if (!taken.has(name)) return name;
  for (let n = 2; ; n++) {
    const candidate = `${name.slice(0, REPO_MAX - String(n).length - 1)}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

// The instance with the repo of this identity in it; added false when it was there already
export function withRepo(instance, id, local = {}) {
  const same = findRepo(instance, id, local);
  if (same) return { instance, repo: same, added: false };
  const repo = id.url ? { name: freeName(instance, id.name), url: id.url } : { name: freeName(instance, id.name), local: localId(id.key) };
  return { instance: { ...instance, repos: [...instance.repos, repo] }, repo, added: true };
}

// Removes the repo of this identity and every local checkout of it from an instance; the names it removed
export function withoutRepo(name, id) {
  const local = checkouts(name);
  let removed = null;
  updateInstance(name, (instance) => {
    const same = findRepo(instance, id, local);
    if (!same) return instance;
    removed = same.name;
    return { ...instance, repos: instance.repos.filter((r) => r !== same) };
  });
  dropCheckouts(name, (_dir, c) => c.key !== id.key);
  return removed;
}

// Effective project settings: the instance gives edition and shared settings, values the repo sets itself win
export function inherit(profile, instance) {
  if (!instance) return profile;
  const shared = Object.fromEntries(['ticketing', 'wallet', 'overlays', 'stations', 'bundle'].filter((k) => k in instance).map((k) => [k, instance[k]]));
  return { ...shared, ...profile, tier: instance.edition, instance: instance.name };
}
