import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isSecureUrl } from '../paths.mjs';

// .kette/wallet.json holds names, environments and the provider, never a value; the values stay in the provider
export const WALLET_PATH = '.kette/wallet.json';
export const SCHEMA_URL = 'https://kette.itdone.de/schema/wallet.schema.json';
export const DEFAULT_PROVIDER = 'infisical';
export const DEFAULT_ENVIRONMENTS = ['dev', 'staging', 'prod'];
export const PROVIDERS = [
  { value: 'infisical', label: 'Infisical (default, cloud or self-hosted)' },
  { value: 'vault', label: 'HashiCorp Vault or OpenBao (KV version 2)' },
  { value: 'aws-secrets-manager', label: 'AWS Secrets Manager' },
  { value: 'azure-key-vault', label: 'Azure Key Vault' },
  { value: 'command', label: 'Your own wallet through commands (1Password, Doppler, pass, ...)' },
];
export const PROVIDER_IDS = PROVIDERS.map((p) => p.value);

export const NAME_PATTERN = /^[A-Z_][A-Z0-9_]{0,127}$/;
export const ENV_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
const APP_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const NOTE_MAX = 200;

// Fields each provider takes; required ones are checked, the rest is optional
const PROVIDER_FIELDS = {
  infisical: { required: ['project'], optional: ['domain', 'path'] },
  vault: { required: ['path'], optional: ['address', 'mount'] },
  'aws-secrets-manager': { required: ['prefix'], optional: ['region'] },
  'azure-key-vault': { required: ['vault'], optional: [] },
  command: { required: ['read', 'write'], optional: ['shell'] },
};

export const walletFile = (root) => path.join(root, WALLET_PATH);

export function readWallet(root) {
  const f = walletFile(root);
  if (!fs.existsSync(f)) return null;
  let wallet;
  try { wallet = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (err) { throw new Error(`${WALLET_PATH} is not valid JSON: ${err.message}`); }
  const errs = validateWallet(wallet);
  if (errs.length) throw new Error(`${WALLET_PATH} is not valid: ${errs.join('; ')}`);
  return wallet;
}

export function writeWallet(root, wallet) {
  const errs = validateWallet(wallet);
  if (errs.length) throw new Error(`Wallet not valid: ${errs.join('; ')}`);
  fs.mkdirSync(path.join(root, '.kette'), { recursive: true });
  fs.writeFileSync(walletFile(root), `${JSON.stringify(wallet, null, 2)}\n`);
}

const isList = (v, check) => Array.isArray(v) && v.every(check) && new Set(v).size === v.length;
const isText = (v) => typeof v === 'string' && v.trim().length > 0 && !/[\r\n]/.test(v);

function providerErrors(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return ['provider must be an object'];
  if (!PROVIDER_IDS.includes(p.id)) return [`provider.id must be one of ${PROVIDER_IDS.join(', ')}`];
  const { required, optional } = PROVIDER_FIELDS[p.id];
  const errs = [];
  for (const k of Object.keys(p)) if (k !== 'id' && !required.includes(k) && !optional.includes(k)) errs.push(`unknown field provider.${k} for ${p.id}`);
  for (const k of required) if (!isText(p[k])) errs.push(`provider.${k} is required for ${p.id}`);
  for (const k of optional) if (k in p && !isText(p[k])) errs.push(`provider.${k} must be a non-empty single line`);
  for (const k of ['domain', 'address']) if (isText(p[k]) && !isSecureUrl(p[k])) errs.push(`provider.${k} must be an https URL`);
  if (p.id === 'command' && 'shell' in p && !['sh', 'bash', 'pwsh'].includes(p.shell)) errs.push('provider.shell must be sh, bash or pwsh');
  return errs;
}

// Errors as "field: problem"; an empty list means valid
export function validateWallet(w) {
  if (!w || typeof w !== 'object' || Array.isArray(w)) return ['the wallet must be a JSON object'];
  const errs = [];
  for (const k of Object.keys(w)) if (!['$schema', 'version', 'provider', 'environments', 'secrets'].includes(k)) errs.push(`unknown field ${k}`);
  if (w.version !== 1) errs.push('version must be 1');
  errs.push(...providerErrors(w.provider));
  if (!isList(w.environments, (e) => typeof e === 'string' && ENV_PATTERN.test(e)) || !w.environments?.length) errs.push('environments must be a list of distinct lowercase names (letters, digits, dashes)');
  if (!Array.isArray(w.secrets)) return [...errs, 'secrets must be a list'];
  const seen = new Set();
  w.secrets.forEach((s, i) => {
    const at = `secrets[${i}]`;
    if (!s || typeof s !== 'object' || Array.isArray(s)) { errs.push(`${at} must be an object`); return; }
    for (const k of Object.keys(s)) if (!['name', 'environments', 'apps', 'note'].includes(k)) errs.push(`unknown field ${at}.${k}`);
    if (typeof s.name !== 'string' || !NAME_PATTERN.test(s.name)) errs.push(`${at}.name must be an environment variable name (A-Z, 0-9, _)`);
    else if (seen.has(s.name)) errs.push(`${at}.name ${s.name} is declared twice`);
    else seen.add(s.name);
    if ('environments' in s && (!isList(s.environments, (e) => typeof e === 'string') || !s.environments.length || s.environments.some((e) => !w.environments?.includes(e)))) errs.push(`${at}.environments must name environments of the wallet`);
    if ('apps' in s && (!isList(s.apps, (a) => typeof a === 'string' && APP_PATTERN.test(a)) || !s.apps.length)) errs.push(`${at}.apps must be a list of app names`);
    if ('note' in s && (!isText(s.note) || s.note.length > NOTE_MAX)) errs.push(`${at}.note must be one line of at most ${NOTE_MAX} characters`);
  });
  return errs;
}

export function newWallet(provider, environments = DEFAULT_ENVIRONMENTS, names = []) {
  return { $schema: SCHEMA_URL, version: 1, provider, environments, secrets: names.map((name) => ({ name })) };
}

// Declared names for one environment, optionally only those of one app (a secret without apps belongs to every app)
export function namesFor(wallet, env, app = null) {
  return wallet.secrets
    .filter((s) => !s.environments || s.environments.includes(env))
    .filter((s) => !app || !s.apps || s.apps.includes(app))
    .map((s) => s.name);
}

export function checkEnv(wallet, env) {
  if (!env) throw new Error(`Choose an environment with --env (${wallet.environments.join(', ')})`);
  if (!wallet.environments.includes(env)) throw new Error(`Environment ${env} is not in the wallet (${wallet.environments.join(', ')})`);
  return env;
}

export function checkName(name) {
  if (!name || !NAME_PATTERN.test(name)) throw new Error(`Secret names are environment variable names (A-Z, 0-9, _, not starting with a digit): ${JSON.stringify(name ?? '')}`);
  return name;
}

// Names from .env.example files (root and app folders), so a new wallet starts with what the project already expects
export function exampleNames(root, folders = []) {
  const names = new Set();
  for (const dir of ['.', ...folders]) {
    for (const f of ['.env.example', '.env.sample', 'env.example']) {
      const file = path.join(root, dir, f);
      if (!fs.existsSync(file)) continue;
      for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=/);
        if (m) names.add(m[1]);
      }
    }
  }
  return [...names];
}

// KEY=value lines of a .env file: export prefix, comments, single quotes literal, double quotes with \n \" \\ escapes (may span lines)
export function parseDotenv(text) {
  const out = new Map();
  const src = text.replace(/\r\n/g, '\n');
  const re = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_.-]*)[ \t]*=[ \t]*/gm;
  let m;
  while ((m = re.exec(src))) {
    let i = re.lastIndex;
    let value;
    if (src[i] === '"') {
      let v = '';
      for (i++; i < src.length && src[i] !== '"'; i++) {
        if (src[i] === '\\' && i + 1 < src.length) { const n = src[++i]; v += n === 'n' ? '\n' : n === 'r' ? '\r' : n === 't' ? '\t' : n; } else v += src[i];
      }
      value = v;
      i = src.indexOf('\n', i);
    } else if (src[i] === "'") {
      const end = src.indexOf("'", i + 1);
      value = end < 0 ? src.slice(i + 1, src.indexOf('\n', i) < 0 ? undefined : src.indexOf('\n', i)) : src.slice(i + 1, end);
      i = src.indexOf('\n', end < 0 ? i : end);
    } else {
      const end = src.indexOf('\n', i);
      value = src.slice(i, end < 0 ? undefined : end).replace(/[ \t]+#.*$/, '').trim();
      i = end;
    }
    out.set(m[1], value);
    re.lastIndex = i < 0 ? src.length : i;
  }
  return out;
}

// Fingerprint of the provider block; a machine trusts exactly this block, any change asks again
export const providerHash = (provider) => crypto.createHash('sha256').update(JSON.stringify(provider, Object.keys(provider).sort())).digest('hex');
