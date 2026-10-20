import { spawnSync } from 'node:child_process';

const run = (args) => spawnSync('claude', args, { encoding: 'utf8' });
export const hasClaude = () => run(['--version']).status === 0;

// Bindet das Regelwerk als Plugin-Marketplace in Claude Code ein (Scope user)
export function installPlugins(bundleDir, plugins) {
  if (!hasClaude()) return { ok: false, reason: 'claude nicht gefunden' };
  const add = run(['plugin', 'marketplace', 'add', bundleDir]);
  const out = (add.stdout || '') + (add.stderr || '');
  if (add.status !== 0 && !/already/i.test(out)) return { ok: false, reason: out.trim() };
  for (const p of plugins) {
    const r = run(['plugin', 'install', `${p}@kette-engineering`]);
    if (r.status !== 0) return { ok: false, reason: ((r.stdout || '') + (r.stderr || '')).trim() };
  }
  return { ok: true };
}

export function installedPlugins() {
  const r = run(['plugin', 'list']);
  return r.status === 0 ? r.stdout : '';
}
