import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Every provider runs the official CLI of the wallet without a shell; values travel through stdin, a private temp file or memory, never as an argument
export class ProviderError extends Error {}

const MAX_BUFFER = 16 * 1024 * 1024;

function exec(bin, args, { input, env } = {}) {
  const r = spawnSync(bin, args, { encoding: 'utf8', input, env: env ? { ...process.env, ...env } : process.env, maxBuffer: MAX_BUFFER, windowsHide: true });
  if (r.error?.code === 'ENOENT') throw new ProviderError(`${bin} not found. ${installHint(bin)}`);
  if (r.error) throw new ProviderError(`${bin} failed: ${r.error.message}`);
  return { code: r.status, out: r.stdout || '', err: (r.stderr || '').trim() };
}

const INSTALL = {
  infisical: 'Install it: https://infisical.com/docs/cli/overview, then sign in with infisical login (or set INFISICAL_TOKEN).',
  vault: 'Install it: https://developer.hashicorp.com/vault/install (OpenBao: bao), then sign in with vault login.',
  aws: 'Install the AWS CLI: https://aws.amazon.com/cli/, then sign in with aws sso login or aws configure.',
  az: 'Install the Azure CLI: https://learn.microsoft.com/cli/azure/install-azure-cli, then sign in with az login.',
  sh: 'Your own provider runs its commands through sh.',
};

export const installHint = (bin) => INSTALL[bin] || `Install ${bin}.`;

// One line of the error output: the message line when the CLI prints one, otherwise the first line naming the cause; never request bodies
export function reason(r) {
  const lines = r.err.replace(/\x1b\[[0-9;]*m/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
  const message = lines.find((l) => /^(message|error):\s*\S/i.test(l) && !/^error:\s*\^D$/i.test(l));
  const cause = lines.find((l) => /login|not found|forbidden|denied|unauthori[sz]ed|expired|permission/i.test(l));
  return (message?.replace(/^(message|error):\s*/i, '') || cause || lines[0] || `exit code ${r.code}`).slice(0, 300);
}
const fail = (what, r) => new ProviderError(`${what}: ${reason(r)}`);

// Private temp file for one value, removed right after use
function withTempFile(content, fn, name = 'value') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kette-wallet-'));
  const file = path.join(dir, name);
  try {
    fs.chmodSync(dir, 0o700);
    fs.writeFileSync(file, content, { mode: 0o600 });
    return fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function parseJson(text, what) {
  try { return JSON.parse(text); } catch { throw new ProviderError(`${what} did not return JSON`); }
}

const infisical = (p) => {
  const base = (env) => ['--env', env, '--projectId', p.project, '--path', p.path || '/', '--silent', ...(p.domain ? ['--domain', p.domain] : [])];
  return {
    bin: 'infisical',
    where: (env) => `Infisical project ${p.project}, environment ${env}, path ${p.path || '/'}${p.domain ? ` on ${p.domain}` : ''}`,
    read(env) {
      const r = exec('infisical', ['export', '--format', 'json', ...base(env)]);
      if (r.code !== 0) throw fail(`Infisical (${env})`, r);
      const list = parseJson(r.out || '[]', 'infisical export');
      return new Map((Array.isArray(list) ? list : []).map((s) => [s.key, s.value]));
    },
    write(env, name, value) {
      // A YAML file keeps the value out of the process list; a JSON string is valid YAML and round-trips quotes, # and newlines
      const r = withTempFile(`${name}: ${JSON.stringify(value)}\n`, (file) => exec('infisical', ['secrets', 'set', '--file', file, '--output', 'json', ...base(env)]), 'value.yaml');
      if (r.code !== 0) throw fail(`Infisical (${env}) could not store ${name}`, r);
    },
  };
};

// KV version 2, one entry per environment under <mount>/<path>/<env>, one key per secret
const vault = (p) => {
  const mount = p.mount || 'secret';
  const entry = (env) => `${p.path.replace(/\/$/, '')}/${env}`;
  const env = p.address ? { VAULT_ADDR: p.address } : undefined;
  return {
    bin: 'vault',
    where: (e) => `Vault ${mount}/${entry(e)}${p.address ? ` on ${p.address}` : ''}`,
    read(e) {
      const r = exec('vault', ['kv', 'get', '-format=json', `-mount=${mount}`, entry(e)], { env });
      if (r.code === 2 && /no value found|not found/i.test(r.err + r.out)) return new Map();
      if (r.code !== 0) throw fail(`Vault (${e})`, r);
      return new Map(Object.entries(parseJson(r.out, 'vault kv get').data?.data || {}));
    },
    write(e, name, value) {
      // patch keeps the other keys; a missing entry is created with put. NAME=- reads the value from stdin
      let r = exec('vault', ['kv', 'patch', `-mount=${mount}`, entry(e), `${name}=-`], { input: value, env });
      if (r.code !== 0 && /no value found|not found|404/i.test(r.err)) r = exec('vault', ['kv', 'put', `-mount=${mount}`, entry(e), `${name}=-`], { input: value, env });
      if (r.code !== 0) throw fail(`Vault (${e}) could not store ${name}`, r);
    },
  };
};

// One secret per environment named <prefix>/<env>, its value a JSON object with one key per secret
const aws = (p) => {
  const id = (env) => `${p.prefix.replace(/\/$/, '')}/${env}`;
  const region = p.region ? ['--region', p.region] : [];
  const missing = (r) => /ResourceNotFoundException/.test(r.err);
  const current = (env) => {
    const r = exec('aws', ['secretsmanager', 'get-secret-value', '--secret-id', id(env), '--query', 'SecretString', '--output', 'text', ...region]);
    if (r.code !== 0 && missing(r)) return null;
    if (r.code !== 0) throw fail(`AWS Secrets Manager (${env})`, r);
    const data = parseJson(r.out.trim() || '{}', 'aws secretsmanager');
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ProviderError(`AWS secret ${id(env)} is not a JSON object of names and values`);
    return data;
  };
  return {
    bin: 'aws',
    where: (env) => `AWS Secrets Manager ${id(env)}${p.region ? ` in ${p.region}` : ''}`,
    read: (env) => new Map(Object.entries(current(env) || {})),
    write(env, name, value) {
      const data = current(env);
      const next = JSON.stringify({ ...(data || {}), [name]: value });
      const args = data ? ['put-secret-value', '--secret-id', id(env)] : ['create-secret', '--name', id(env)];
      const r = withTempFile(next, (file) => exec('aws', ['secretsmanager', ...args, '--secret-string', `file://${file}`, '--output', 'json', ...region]));
      if (r.code !== 0) throw fail(`AWS Secrets Manager (${env}) could not store ${name}`, r);
    },
  };
};

// Key Vault allows letters, digits and dashes: <env>--<NAME with dashes>, the double dash keeps environment and name apart
export const azureName = (env, name) => `${env}--${name.replace(/_/g, '-')}`;
const azure = (p) => ({
  bin: 'az',
  where: (env) => `Azure Key Vault ${p.vault}, prefix ${env}--`,
  read(env, names = []) {
    const map = new Map();
    for (const name of names) {
      const r = exec('az', ['keyvault', 'secret', 'show', '--vault-name', p.vault, '--name', azureName(env, name), '--query', 'value', '-o', 'tsv']);
      if (r.code !== 0 && /SecretNotFound|was not found/i.test(r.err)) continue;
      if (r.code !== 0) throw fail(`Azure Key Vault (${env})`, r);
      map.set(name, r.out.replace(/\r?\n$/, ''));
    }
    return map;
  },
  write(env, name, value) {
    const r = withTempFile(value, (file) => exec('az', ['keyvault', 'secret', 'set', '--vault-name', p.vault, '--name', azureName(env, name), '--file', file, '--encoding', 'utf-8', '-o', 'none']));
    if (r.code !== 0) throw fail(`Azure Key Vault (${env}) could not store ${name}`, r);
  },
});

// Own wallet: read prints one value to stdout, write takes it on stdin; {name} and {env} are validated before they are filled in
export const fill = (template, env, name) => template.replace(/\{env\}/g, env).replace(/\{name\}/g, name);
const command = (p) => {
  const shell = p.shell || (process.platform === 'win32' ? 'pwsh' : 'sh');
  const run = (line, input) => exec(shell, shell === 'pwsh' ? ['-NoProfile', '-Command', line] : ['-c', line], { input });
  return {
    bin: shell,
    where: (env) => `own commands (${shell}), environment ${env}`,
    read(env, names = []) {
      const map = new Map();
      for (const name of names) {
        const r = run(fill(p.read, env, name));
        if (r.code === 0) map.set(name, r.out.replace(/\r?\n$/, ''));
      }
      return map;
    },
    write(env, name, value) {
      const r = run(fill(p.write, env, name), value);
      if (r.code !== 0) throw fail(`Own wallet (${env}) could not store ${name}`, r);
    },
  };
};

const FACTORIES = { infisical, vault, 'aws-secrets-manager': aws, 'azure-key-vault': azure, command };

export const providerFor = (p) => FACTORIES[p.id](p);

// Whether the CLI of the provider is on this machine; null when it is missing
export function providerVersion(p) {
  const { bin } = providerFor(p);
  if (bin === 'sh' || bin === 'bash') return 'shell';
  try {
    const r = exec(bin, bin === 'az' ? ['version', '-o', 'tsv'] : ['--version']);
    return r.code === 0 ? (r.out || r.err).trim().split('\n')[0] : null;
  } catch {
    return null;
  }
}
