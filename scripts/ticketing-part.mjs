// What of kette-ticketing goes into the Enterprise bundle, and the checks that nothing internal goes with it (docs/adr/0003, KETTE-27, KETTE-32)
import fs from 'node:fs';
import path from 'node:path';

// The Enterprise plugin with the intake agent and the /intake command, built from agent/ and commands/ of kette-ticketing (KETTE-30)
export const TICKETING_PLUGIN = 'kette-ticketing';
// Files of the ticketing part; the neutral routing ships, the routing of Get IT Done, the backfill and the migrations never do
export const PART_FILES = ['dist', 'routing.default.json', 'package.json', ...['cli-facade', 'plan-guard', 'workbase-session', 'intake-hook', 'intake-classify'].map((f) => `scripts/${f}.mjs`)];
// The one host of Get IT Done a customer bundle may name: the public workload.zero API
const PUBLIC_API = 'api.workbase.itdone.de';
// Words that never ship, in any case, URL-encoded or Base64: repos and machines of Get IT Done and names from the review (KETTE-32)
export const DENY_WORDS = ['alexfriedl', 'alexanderfriedl', 'spark', 'kneier', 'braun-partner'];

const FORBIDDEN = [
  ['session name', /alexanderfriedl-[0-9a-z]+/i],
  ['Figma URL', /figma\.com\/(?:file|design|board|proto|make|slides|deck|community\/file)\/[a-z0-9]{6,}/i],
  ['Figma file key', /"key"\s*:\s*"[a-z0-9]{20,24}"|file_?key['"]?\s*[:=]\s*['"`][a-z0-9]{10,}/i],
  ['private address', /(?<![\d.])(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01])|169\.254)\.\d{1,3}\.\d{1,3}(?![\d.])/],
  ['private IPv6 address', /\[?(?<![0-9a-f:])(?:f[cd][0-9a-f]{0,2}|fe[89ab][0-9a-f]?):[0-9a-f:]*\]?/i],
  ['e-mail address', /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/i],
  ['24-hex id', /(?<![0-9a-f])[0-9a-f]{24}(?![0-9a-f])/i],
];

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A dash belongs to the word, so design-tokens-maintainer is no hit for Design-Tokens
const word = (w) => new RegExp(`(?<![a-z0-9-])${escape(w)}(?![a-z0-9-])`, 'i');

// The Base64 forms of a word at the three possible offsets, only the characters the word decides alone
export function base64Forms(text) {
  const forms = [];
  for (const variant of new Set([text, text.toLowerCase()])) {
    for (let off = 0; off < 3; off++) {
      const enc = Buffer.from('\0'.repeat(off) + variant).toString('base64');
      const form = enc.slice([0, 2, 3][off], Math.floor((off + variant.length) / 3) * 4);
      if (form.length >= 6) forms.push(form);
    }
  }
  return forms;
}

// Every string of a JSON value, recursively; with keys also the field names
const strings = (v, keys = false) => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap((x) => strings(x, keys)) : v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => [...(keys ? [k] : []), ...strings(x, keys)]) : []);

// The strings of the instance fragment of Get IT Done as words that never ship, without the names and values the neutral routing uses
export function denyWordsFrom(fragment, neutral) {
  const known = new Set([...strings(neutral, true), 'owner', 'member'].map((s) => s.toLowerCase()));
  // A single capitalised word (a Figma file named Records or Settings) is ordinary language, not a secret
  return [...new Set(strings(fragment).filter((s) => s.trim().length >= 4 && !known.has(s.toLowerCase()) && !/^\p{Lu}\p{Ll}+$/u.test(s)))];
}

const decoded = (text) => text.replace(/%([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));

// Every finding as "file: what (match)"; an empty list means the folder may ship
export function forbiddenIn(dir, { denyWords = [] } = {}) {
  const words = [...DENY_WORDS, ...denyWords];
  const out = [];
  for (const f of walk(dir)) {
    const raw = fs.readFileSync(f, 'utf8');
    const text = `${raw}\n${decoded(raw)}`;
    const rel = path.relative(dir, f).split(path.sep).join('/');
    for (const [what, re] of FORBIDDEN) {
      const m = text.match(re);
      if (m) out.push(`${rel}: ${what} (${m[0].slice(0, 60)})`);
    }
    for (const host of text.match(/[a-z0-9.-]*\.itdone\.(?:de|cloud)/gi) ?? []) if (host.toLowerCase() !== PUBLIC_API) out.push(`${rel}: internal host (${host})`);
    for (const w of words) {
      if (word(w).test(text)) out.push(`${rel}: internal word (${w.slice(0, 60)})`);
      else if (base64Forms(w).some((b) => raw.includes(b))) out.push(`${rel}: internal word in Base64 (${w.slice(0, 60)})`);
    }
  }
  return [...new Set(out)];
}

const ALLOWED = {
  top: ['$schema', 'version', 'source', 'chainOrder', 'offChain', 'members', 'stations', 'routes', 'rules'],
  station: ['visible', 'defaultArtifact', 'aliases', 'dsOwned', 'definitionOfDone'],
  member: ['kind', 'heavy', 'label'],
  route: ['station', 'artifact', 'owner', 'builder', 'review', 'gates'],
  rules: ['chainStartWins', 'batchReview', 'maxHeavyAgents', 'followThrough'],
};
const extra = (obj, allowed, at) => Object.keys(obj ?? {}).filter((k) => !allowed.includes(k)).map((k) => `${at}${k} is not allowed in the neutral routing`);

// The positive list of the shipped routing: only neutral fields, only agent roles the bundle ships, owners only the placeholder (KT-N1, KT-N4)
export function routingErrors(routing, agents) {
  const known = (id) => id === '@owner' || agents.has(String(id).split(':').pop());
  const errs = [...extra(routing, ALLOWED.top, ''), ...extra(routing.rules, ALLOWED.rules, 'rules.')];
  if (JSON.stringify(routing).includes('currentName')) errs.push('currentName is not allowed in the neutral routing');
  for (const [id, s] of Object.entries(routing.stations ?? {})) errs.push(...extra(s, ALLOWED.station, `stations.${id}.`));
  for (const [id, m] of Object.entries(routing.members ?? {})) {
    errs.push(...extra(m, ALLOWED.member, `members.${id}.`));
    if (m.kind !== 'agent') errs.push(`members.${id} is ${m.kind}, the neutral routing holds agent roles only`);
    if (!known(id)) errs.push(`members.${id} is no agent of the Enterprise bundle`);
  }
  (routing.routes ?? []).forEach((r, i) => {
    errs.push(...extra(r, ALLOWED.route, `routes[${i}].`));
    if (r.owner !== '@owner') errs.push(`routes[${i}].owner must be @owner, owners come from the instance`);
    for (const id of [r.builder, ...(r.gates ?? [])]) if (!known(id)) errs.push(`routes[${i}] names ${id}, no agent of the Enterprise bundle`);
  });
  return errs;
}

// Agent names of the plugins in these folders (plugins/<name>/agents/<agent>.md)
export function agentsIn(...pluginDirs) {
  const names = new Set();
  for (const dir of pluginDirs) {
    if (!fs.existsSync(dir)) continue;
    for (const p of fs.readdirSync(dir)) {
      const agents = path.join(dir, p, 'agents');
      if (fs.existsSync(agents)) for (const f of fs.readdirSync(agents)) if (f.endsWith('.md')) names.add(f.slice(0, -3));
    }
  }
  return names;
}

// The plugin folder kette-ticketing from a kette-ticketing checkout: agents/kette-intake.md and commands/intake.md
export function writePlugin(src, dest, version) {
  fs.mkdirSync(path.join(dest, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(dest, '.claude-plugin', 'plugin.json'), `${JSON.stringify({ name: TICKETING_PLUGIN, description: 'Decisions as tickets (Kette Enterprise): the kette-intake agent and the /intake command', version }, null, 2)}\n`);
  for (const [from, to] of [['agent', 'agents'], ['commands', 'commands']]) fs.cpSync(path.join(src, from), path.join(dest, to), { recursive: true });
  return dest;
}

export const marketEntry = (version) => ({ name: TICKETING_PLUGIN, description: 'Decisions as tickets: kette-intake agent and /intake', source: `./plugins/${TICKETING_PLUGIN}`, version });
