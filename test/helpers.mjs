import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kette-test-'));
export const write = (dir, f, c) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); };
export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// Packt einen Ordner als .tgz und liefert Inhalt und Prüfsumme
export function tarball(srcDir, entries = ['.']) {
  const out = path.join(tmp(), 'pkg.tgz');
  execFileSync('tar', ['-czf', out, '-C', srcDir, ...entries], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  const buf = fs.readFileSync(out);
  return { buf, sha256: sha256(buf) };
}

// Minimales Regelwerk-Paket mit Marketplace und Schema, reicht für init und doctor
export function fakeBundle(version) {
  const d = tmp();
  write(d, '.claude-plugin/marketplace.json', JSON.stringify({ name: 'kette', version, plugins: [] }));
  write(d, 'VERSION', version + '\n');
  write(d, 'rules/architecture/adr-vorlage.md', '# ADR\n');
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

// Ersetzt claude im PATH durch ein Skript, das Aufrufe protokolliert; list ist die Antwort auf marketplace list --json, plugins die auf plugin list
export function fakeClaude(list = [], plugins = '') {
  const bin = tmp();
  const log = path.join(bin, 'calls.log');
  const listFile = path.join(bin, 'list.json');
  const pluginsFile = path.join(bin, 'plugins.txt');
  fs.writeFileSync(listFile, JSON.stringify(list));
  fs.writeFileSync(pluginsFile, plugins);
  write(bin, 'claude', `#!/bin/sh\necho "$*" >> "${log}"\ncase "$*" in "plugin marketplace list --json") cat "${listFile}";; "plugin list") cat "${pluginsFile}";; esac\nexit 0\n`);
  fs.chmodSync(path.join(bin, 'claude'), 0o755);
  const orig = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${orig}`;
  return {
    calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []),
    restore: () => { process.env.PATH = orig; },
  };
}
