import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ENTERPRISE, editionLabel } from './editions.mjs';
import { bold, cmd, file, symbols } from './out.mjs';

const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const plain = (s) => s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').trim();
const cells = (row) => row.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
const short = (s, max) => (s.length > max ? `${s.slice(0, max - 3).trimEnd()}...` : s);

// Path with ~ instead of the home folder, shorter in output and usable in the shell
export const tilde = (p) => {
  const rel = path.relative(os.homedir(), p);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? path.join('~', rel) : p;
};

// First sentence after the heading, otherwise the first rule; one line for the overview
function summary(md) {
  const lines = md.split('\n').slice(1).map((l) => l.trim());
  const text = lines.find((l) => l && !l.startsWith('#')) || '';
  return plain(text.replace(/^- /, '')).split(/(?<=\.)\s/)[0];
}

// Rows of a Markdown table without header and separator
function tableRows(md) {
  return md.split('\n').filter((l) => l.trim().startsWith('|')).slice(2).map(cells);
}

function coreTopics(dir) {
  const core = path.join(dir, 'rules', 'core');
  if (!fs.existsSync(core)) return [];
  return fs.readdirSync(core).filter((f) => /^\d+-.+\.md$/.test(f)).sort().map((f) => {
    const md = read(path.join(core, f));
    return { id: f.replace(/^\d+-|\.md$/g, ''), aliases: [f.replace(/\.md$/, '')], title: plain(md.split('\n')[0].replace(/^#+\s*/, '')), summary: summary(md), file: path.join(core, f) };
  });
}

function patternTopics(dir) {
  const arch = path.join(dir, 'rules', 'architecture');
  return tableRows(read(path.join(arch, 'README.md'))).map(([id, link, brief]) => {
    const file = (link.match(/\(([^)]+)\)/) || [])[1] || '';
    return { id: plain(id), aliases: [file.replace(/\.md$/, '')], title: plain(link), summary: plain(brief || ''), file: path.join(arch, file) };
  }).filter((t) => t.id);
}

function stackTopics(dir) {
  const stack = path.join(dir, 'profiles', 'stack');
  return tableRows(read(path.join(stack, 'README.md'))).map(([id, link, usage]) => {
    const file = (link.match(/\(([^)]+)\)/) || [])[1] || '';
    return { id: plain(id), aliases: [], title: plain(id), summary: plain(usage || ''), file: path.join(stack, file) };
  }).filter((t) => t.id && fs.existsSync(t.file));
}

function platformTopics(dir) {
  const index = readJson(path.join(dir, 'profiles', 'platform', 'index.json')) || [];
  return index.map((p) => ({ id: p.id, aliases: [], title: p.name, summary: `${p.name}, ${p.status}`, status: p.status, file: path.join(dir, 'profiles', 'platform', p.id, 'profile.md') }));
}

// All topics of the bundle; profiles without a file in the bundle (Community) stay known but not readable
// renamed: German topic names of older rulebooks mapped to the English ones (rules/aliases.json)
export function catalog(dir) {
  return {
    core: coreTopics(dir),
    patterns: patternTopics(dir),
    stacks: stackTopics(dir),
    platforms: platformTopics(dir),
    renamed: readJson(path.join(dir, 'rules', 'aliases.json'))?.topics || {},
  };
}

function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length];
}

export function suggest(input, ids) {
  const q = input.toLowerCase();
  return ids.filter((id) => id.includes(q) || q.includes(id) || distance(q, id) <= Math.max(2, Math.floor(id.length / 3))).slice(0, 3);
}

const pad = (s, n) => s + ' '.repeat(Math.max(1, n - s.length));

function overview(bundle, tier, cat) {
  const out = [`Die Kette rulebook ${symbols().sep} edition ${editionLabel(tier)}, version ${bundle.version}`, `Location: ${file(tilde(bundle.dir))}`, ''];
  const width = Math.max(...[...cat.core, ...cat.patterns, ...cat.stacks, ...cat.platforms].map((t) => t.id.length)) + 2;
  // One line per topic, cut to the terminal width
  const row = (id, text) => `  ${pad(id, width)}${short(text, Math.max(40, (process.stdout.columns || 100) - width - 3))}`;
  out.push(bold('Core rules (always apply)'));
  for (const t of cat.core) out.push(row(t.id, t.summary || t.title));
  out.push('', bold('Architecture patterns (chosen in .kette/profile.json)'));
  for (const t of cat.patterns) out.push(row(t.id, `${t.title}: ${t.summary}`));
  if (tier === ENTERPRISE) {
    out.push('', bold('Stack profiles'));
    for (const t of cat.stacks) out.push(row(t.id, t.summary));
    out.push('', bold('Platform profiles'));
    for (const t of cat.platforms) out.push(row(t.id, t.summary));
  } else {
    out.push('', `Stack and platform profiles come with Enterprise (Die Kette): ${cmd('kette login <key>')}`);
  }
  out.push('', `Read a topic: ${cmd('kette rules <topic>')}${cat.core[0] ? `, e.g. ${cmd(`kette rules ${cat.core[0].id}`)}` : ''} ${symbols().sep} file paths: --path`);
  return out.join('\n');
}

// Light Markdown cleanup: headings without #, emphasis and links as text, code indented, tables as columns
export function render(md) {
  const out = [];
  let code = false;
  let table = [];
  const flush = () => {
    if (!table.length) return;
    const rows = table.filter((r) => !r.every((c) => /^:?-+:?$/.test(c))).map((r) => r.map(plain));
    const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => (r[i] || '').length)));
    for (const r of rows) out.push(`  ${r.map((c, i) => (i < r.length - 1 ? c.padEnd(widths[i] + 2) : c)).join('')}`);
    table = [];
  };
  for (const line of md.replace(/\n+$/, '').split('\n')) {
    if (line.trim().startsWith('```')) { flush(); code = !code; continue; }
    if (code) { out.push(`    ${line}`); continue; }
    if (line.trim().startsWith('|')) { table.push(cells(line)); continue; }
    flush();
    const h = line.match(/^(#+)\s+(.*)$/);
    if (h) {
      if (out.length && out[out.length - 1] !== '') out.push('');
      out.push(bold(h[1].length === 1 ? plain(h[2]).toUpperCase() : plain(h[2])));
      continue;
    }
    const item = line.match(/^(\s*)[-*]\s+(.*)$/);
    if (item) { out.push(`${item[1]}  - ${plain(item[2])}`); continue; }
    out.push(plain(line.replace(/^>\s?/, '')));
  }
  flush();
  return out.join('\n');
}

function find(cat, topic) {
  const q = topic.toLowerCase();
  const all = [...cat.core, ...cat.patterns, ...cat.stacks, ...cat.platforms];
  const match = (id) => all.find((t) => t.id === id || t.aliases.includes(id));
  return { hit: match(q) || (Object.hasOwn(cat.renamed, q) ? match(cat.renamed[q]) : undefined), ids: all.map((t) => t.id) };
}

// kette rules [topic] [--path]; reads only the installed bundle, no network
export function rules(topic, opts, { bundle, tier, stackIds = [] }) {
  if (!bundle) throw new Error('No rulebook on this machine. Load it with kette init (new project), kette add (existing repo) or kette update.');
  const cat = catalog(bundle.dir);
  if (!topic) {
    if (opts.path) {
      const files = [...cat.core, ...cat.patterns, ...cat.stacks, ...cat.platforms].map((t) => t.file).filter((f) => fs.existsSync(f));
      console.log([bundle.dir, ...files].join('\n'));
    } else console.log(overview(bundle, tier, cat));
    return 0;
  }
  const { hit, ids } = find(cat, topic);
  const missing = !hit || !fs.existsSync(hit.file);
  if (missing && tier !== ENTERPRISE && (cat.platforms.includes(hit) || stackIds.includes(topic.toLowerCase()))) {
    throw new Error(`${topic} is an Enterprise profile (Die Kette), unlock with: kette login <key>`);
  }
  if (hit && missing) throw new Error(`${tilde(hit.file)} is missing from the bundle. Reload with: kette update`);
  if (!hit) {
    const close = suggest(topic, [...ids, ...stackIds.filter((s) => !ids.includes(s))]);
    throw new Error(`Unknown topic "${topic}".${close.length ? ` Did you mean: ${close.join(', ')}?` : ''} All topics: kette rules`);
  }
  console.log(opts.path ? hit.file : render(read(hit.file)));
  return 0;
}
