import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kette-test-'));

// Tests schreiben nie in die echte ~/.npmrc
process.env.NPM_CONFIG_USERCONFIG = path.join(tmp(), 'user.npmrc');
delete process.env.npm_config_userconfig;
export const write = (dir, f, c) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); };
export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// Packt einen Ordner als .tgz und liefert Inhalt und Prüfsumme
export function tarball(srcDir, entries = ['.']) {
  const out = path.join(tmp(), 'pkg.tgz');
  execFileSync('tar', ['-czf', out, '-C', srcDir, ...entries], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  const buf = fs.readFileSync(out);
  return { buf, sha256: sha256(buf) };
}

// Minimales Regelwerk-Paket mit Marketplace und Schema, reicht für init und doctor; extra sind weitere Dateien (Pfad: Inhalt)
export function fakeBundle(version, plugins = ['kette-engineering-core', 'ui-gesetze', 'kette-engineering', 'design-system-agents', 'design-review-pack'], extra = {}) {
  const d = tmp();
  for (const [f, c] of Object.entries(extra)) write(d, f, c);
  write(d, '.claude-plugin/marketplace.json', JSON.stringify({ name: 'kette', version, plugins: [] }));
  write(d, 'VERSION', version + '\n');
  write(d, 'rules/architecture/adr-vorlage.md', '# ADR\n');
  for (const p of plugins) write(d, `plugins/${p}/.claude-plugin/plugin.json`, JSON.stringify({ name: p }));
  write(d, 'schema/profile.schema.json', JSON.stringify({
    type: 'object',
    required: ['version', 'project', 'stack', 'platform', 'patterns'],
    properties: { tier: { enum: ['community', 'enterprise'] } },
  }));
  return tarball(d);
}

// HTTP-Server auf einem freien Port; handler(req, res, body) beantwortet jede Anfrage
export async function serve(handler) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => handler(req, res, body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

export const json = (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };

// Fängt console.log ab, damit Tests die Ausgabe prüfen können
export async function capture(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try { return { result: await fn(), out: lines.join('\n') }; } finally { console.log = orig; }
}

// Ersetzt claude im PATH durch ein Node-Skript mit Zustand: list ist die Antwort auf marketplace list --json, plugins die installierten Plugin-IDs (Text, IDs werden herausgelesen)
// install und uninstall ändern den Zustand; responses legt je Aufruf (z. B. 'plugin install a@kette') { code, out } fest, ohne den Zustand zu ändern
export function fakeClaude(list = [], plugins = '', responses = {}) {
  const bin = tmp();
  const log = path.join(bin, 'calls.log');
  const state = path.join(bin, 'state.json');
  fs.writeFileSync(state, JSON.stringify({ list, plugins: plugins.match(/\S+@\S+/g) || [], responses }));
  write(bin, 'claude', `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2).join(' ');
fs.appendFileSync(${JSON.stringify(log)}, args + '\\n');
const s = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, 'utf8'));
const save = () => fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(s));
const r = s.responses[args];
if (r) { if (r.out) console.log(r.out); process.exit(r.code || 0); }
const [a, b, c] = process.argv.slice(2);
if (args === '--version') console.log('9.9.9 (Claude Code)');
else if (args === 'plugin marketplace list --json') console.log(JSON.stringify(s.list));
else if (args === 'plugin list') console.log(s.plugins.length ? 'Installed plugins:\\n\\n' + s.plugins.map((id) => '  ❯ ' + id + '\\n    Status: enabled').join('\\n') : 'No plugins installed.');
else if (a === 'plugin' && b === 'install') { if (!s.plugins.includes(c)) s.plugins.push(c); save(); }
else if (a === 'plugin' && b === 'uninstall') {
  if (!s.plugins.includes(c)) { console.log('Plugin ' + c + ' is not installed'); process.exit(1); }
  s.plugins = s.plugins.filter((id) => id !== c); save();
}
`);
  fs.chmodSync(path.join(bin, 'claude'), 0o755);
  // Windows starts neither shebang nor extensionless files; the CLI then falls back to claude.cmd
  write(bin, 'claude.cmd', `@node "${path.join(bin, 'claude')}" %*\r\n`);
  const orig = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${orig}`;
  return {
    calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []),
    installed: () => JSON.parse(fs.readFileSync(state, 'utf8')).plugins,
    restore: () => { process.env.PATH = orig; },
  };
}
