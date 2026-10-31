// What of kette-ticketing goes into the Enterprise bundle, and the check that nothing internal goes with it (docs/adr/0003, KETTE-27)
import fs from 'node:fs';
import path from 'node:path';

// The Enterprise plugin with the intake agent and the /intake command, built from agent/ and commands/ of kette-ticketing (KETTE-30)
export const TICKETING_PLUGIN = 'kette-ticketing';
// Files of the ticketing part; the neutral routing ships, the routing of Get IT Done, the backfill and the migrations never do
export const PART_FILES = ['dist', 'routing.default.json', 'package.json', ...['cli-facade', 'plan-guard', 'workbase-session', 'intake-hook', 'intake-classify'].map((f) => `scripts/${f}.mjs`)];

// Internal content that must never reach a customer: repos of Get IT Done, session names, Figma file keys, private addresses, the Spark
const FORBIDDEN = [
  ['repo of Get IT Done', /alexfriedl\//],
  ['session name', /alexanderfriedl-[0-9a-z]+/],
  ['Figma file key', /figma\.com\/(?:file|design|board|proto)\/[A-Za-z0-9]{10,}|"key"\s*:\s*"[A-Za-z0-9]{20,24}"/],
  ['private address', /(?<![\d.])(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}(?![\d.])/],
  ['internal machine name', /\bSpark\b/],
];

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));

// Every finding as "file: what (match)"; an empty list means the folder may ship
export function forbiddenIn(dir) {
  const out = [];
  for (const f of walk(dir)) {
    const text = fs.readFileSync(f, 'utf8');
    for (const [what, re] of FORBIDDEN) {
      const m = text.match(re);
      if (m) out.push(`${path.relative(dir, f).split(path.sep).join('/')}: ${what} (${m[0].slice(0, 60)})`);
    }
  }
  return out;
}

// The plugin folder kette-ticketing from a kette-ticketing checkout: agents/kette-intake.md and commands/intake.md
export function writePlugin(src, dest, version) {
  fs.mkdirSync(path.join(dest, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(dest, '.claude-plugin', 'plugin.json'), `${JSON.stringify({ name: TICKETING_PLUGIN, description: 'Decisions as tickets (Kette Enterprise): the kette-intake agent and the /intake command', version }, null, 2)}\n`);
  for (const [from, to] of [['agent', 'agents'], ['commands', 'commands']]) fs.cpSync(path.join(src, from), path.join(dest, to), { recursive: true });
  return dest;
}

export const marketEntry = (version) => ({ name: TICKETING_PLUGIN, description: 'Decisions as tickets: kette-intake agent and /intake', source: `./plugins/${TICKETING_PLUGIN}`, version });
