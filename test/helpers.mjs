import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kette-test-'));

// Tests schreiben nie in die echte ~/.npmrc
process.env.NPM_CONFIG_USERCONFIG = path.join(tmp(), 'user.npmrc');
// Tests never read or write the real ~/.kette (a machine signed in to Enterprise changed the help line)
process.env.KETTE_HOME = tmp();
// Tests never read the real Claude Code settings either
process.env.CLAUDE_CONFIG_DIR = tmp();
delete process.env.npm_config_userconfig;
// Output assertions expect plain text, even when the shell running the tests forces colors
delete process.env.FORCE_COLOR;
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
export function fakeBundle(version, plugins = ['kette-engineering-core', 'ui-laws', 'kette-engineering', 'design-system-agents', 'design-review-pack'], extra = {}) {
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
// mcp maps MCP server names to URLs, or to { url, port } for a server added with --client-id and --callback-port;
// mcp get shows a header with a secret, like Claude Code does for servers added with --header, and the OAuth line of Claude Code 2.1
export function fakeClaude(list = [], plugins = '', responses = {}, mcp = {}) {
  const bin = tmp();
  const log = path.join(bin, 'calls.log');
  const cwdLog = path.join(bin, 'cwd.log');
  const state = path.join(bin, 'state.json');
  fs.writeFileSync(state, JSON.stringify({ list, plugins: plugins.match(/\S+@\S+/g) || [], responses, mcp }));
  write(bin, 'claude', `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2).join(' ');
fs.appendFileSync(${JSON.stringify(log)}, args + '\\n');
fs.appendFileSync(${JSON.stringify(cwdLog)}, process.cwd() + '\\n');
const path = require('node:path');
const argv = process.argv.slice(2);
const scope = argv.includes('--scope') ? argv[argv.indexOf('--scope') + 1] : 'user';
// Scopes as Claude Code keeps them: project in .claude/settings.json, local in .claude/settings.local.json of the folder it runs in,
// user in CLAUDE_CONFIG_DIR/settings.json, written only when a test points CLAUDE_CONFIG_DIR to a sandbox
const settingsFile = (sc) => (sc === 'project' ? path.join(process.cwd(), '.claude', 'settings.json') : sc === 'local' ? path.join(process.cwd(), '.claude', 'settings.local.json') : process.env.CLAUDE_CONFIG_DIR && path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json'));
const edit = (sc, change) => {
  const f = settingsFile(sc);
  if (!f) return;
  let cur = {};
  try { cur = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
  change(cur);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(cur, null, 2) + '\\n');
};
const s = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, 'utf8'));
const save = () => fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(s));
const r = s.responses[args];
if (r) { if (r.out) console.log(r.out); process.exit(r.code || 0); }
const [a, b, c] = process.argv.slice(2);
if (args === '--version') console.log('9.9.9 (Claude Code)');
else if (args === 'plugin marketplace list --json') console.log(JSON.stringify(s.list));
else if (args === 'plugin list') console.log(s.plugins.length ? 'Installed plugins:\\n\\n' + s.plugins.map((id) => '  ❯ ' + id + '\\n    Status: enabled').join('\\n') : 'No plugins installed.');
else if (a === 'mcp' && b === 'get') {
  if (!s.mcp[c]) { console.error('No MCP server named "' + c + '". Configured servers: ' + Object.keys(s.mcp).join(', ')); process.exit(1); }
  const e = typeof s.mcp[c] === 'string' ? { url: s.mcp[c] } : s.mcp[c];
  const oauth = e.port ? '  OAuth: client_id configured, callback_port ' + e.port + '\\n' : '';
  console.log(c + ':\\n  Scope: User config (available in all your projects)\\n  Status: ✔ Connected\\n  Type: http\\n  URL: ' + e.url + '\\n' + oauth + '  Headers:\\n    Authorization: Bearer fake-secret-value\\n');
}
else if (args === 'mcp list') console.log('Checking MCP server health…\\n\\n' + Object.entries(s.mcp).map(([n, u]) => n + ': ' + (u.url || u) + ' (HTTP) - ✔ Connected').join('\\n'));
else if (a === 'mcp' && b === 'add') {
  const argv = process.argv.slice(2);
  const [name, url] = argv.slice(-2);
  if (s.mcp[name]) { console.error('MCP server ' + name + ' already exists in user config'); process.exit(1); }
  const flag = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : null);
  s.mcp[name] = flag('--client-id') ? { url, clientId: flag('--client-id'), port: Number(flag('--callback-port')) } : url; save();
  // User scope MCP servers live in .claude.json of the config folder, written only for a sandbox
  if (flag('-s') === 'user' && process.env.CLAUDE_CONFIG_DIR) { const f = path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json'); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify({ mcpServers: s.mcp }, null, 2)); }
}
else if (a === 'plugin' && b === 'marketplace' && c === 'add') {
  const source = argv[argv.length - 1];
  const name = JSON.parse(fs.readFileSync(path.join(source, '.claude-plugin', 'marketplace.json'), 'utf8')).name;
  // Claude Code refuses a second registration of a known name, whatever folder it points to
  if (s.list.some((m) => m.name === name)) { console.error("Marketplace '" + name + "' is already installed"); process.exit(1); }
  s.list = [...s.list.filter((m) => m.name !== name), { name, source: 'directory', path: source }]; save();
  edit(scope, (cur) => { cur.extraKnownMarketplaces = { ...cur.extraKnownMarketplaces, [name]: { source: { source: 'directory', path: source } } }; });
  // The registry of marketplace names is global in Claude Code, also for a marketplace declared in a project
  if (process.env.CLAUDE_CONFIG_DIR) { const f = path.join(process.env.CLAUDE_CONFIG_DIR, 'plugins', 'known_marketplaces.json'); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(Object.fromEntries(s.list.map((m) => [m.name, m])), null, 2)); }
}
else if (a === 'plugin' && b === 'marketplace' && c === 'remove') {
  const name = argv[3];
  if (!s.list.some((m) => m.name === name)) { console.error('Marketplace ' + name + ' not found'); process.exit(1); }
  s.list = s.list.filter((m) => m.name !== name); save();
  // As Claude Code does (checked with mrm.sh): run inside a project, it also strips the marketplace from that project's settings
  for (const sc of ['project', 'local']) {
    const f = settingsFile(sc);
    if (!fs.existsSync(f)) continue;
    edit(sc, (cur) => {
      if (cur.enabledPlugins) for (const id of Object.keys(cur.enabledPlugins)) if (id.endsWith('@' + name)) delete cur.enabledPlugins[id];
      if (cur.extraKnownMarketplaces) delete cur.extraKnownMarketplaces[name];
    });
  }
}
else if (a === 'plugin' && b === 'install') { if (!s.plugins.includes(c)) s.plugins.push(c); save(); edit(scope, (cur) => { cur.enabledPlugins = { ...cur.enabledPlugins, [c]: true }; }); }
else if (a === 'plugin' && b === 'uninstall') {
  const userFile = settingsFile('user');
  const inUser = userFile && fs.existsSync(userFile) && JSON.parse(fs.readFileSync(userFile, 'utf8')).enabledPlugins?.[c];
  if (!s.plugins.includes(c) && !inUser) { console.log('Plugin ' + c + ' is not installed'); process.exit(1); }
  s.plugins = s.plugins.filter((id) => id !== c); save();
  edit(scope, (cur) => { if (cur.enabledPlugins) delete cur.enabledPlugins[c]; });
}
`);
  fs.chmodSync(path.join(bin, 'claude'), 0o755);
  // Windows starts neither shebang nor extensionless files; the CLI then falls back to claude.cmd
  write(bin, 'claude.cmd', `@node "${path.join(bin, 'claude')}" %*\r\n`);
  const orig = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${orig}`;
  return {
    calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []),
    // Folder each call ran in, same order as calls()
    cwds: () => (fs.existsSync(cwdLog) ? fs.readFileSync(cwdLog, 'utf8').trim().split('\n') : []),
    installed: () => JSON.parse(fs.readFileSync(state, 'utf8')).plugins,
    mcp: () => JSON.parse(fs.readFileSync(state, 'utf8')).mcp,
    restore: () => { process.env.PATH = orig; },
  };
}

// Small deterministic PRNG (mulberry32), so a failing random case can be replayed from its seed
export function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
