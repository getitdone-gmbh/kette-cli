import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { capture, fakeClaude, tmp, write } from './helpers.mjs';
import { main } from '../src/cli.mjs';

const VERSION = '0.20261020.9';
let kh;

// Entpacktes Regelwerk wie unter ~/.kette/bundles/<tier>/<version>, im Stand von state.json eingetragen
function rulebook(tier, { profiles = false } = {}) {
  const d = path.join(kh, 'bundles', tier, VERSION);
  write(d, 'rules/core/README.md', '# Kern-Regeln\n');
  write(d, 'rules/core/01-lesbarkeit.md', '# Lesbarkeit\n\nCode wird öfter gelesen als geschrieben. Clever verliert.\n');
  write(d, 'rules/core/03-fehler.md', '# Fehler\n\n## Regeln\n- Leere `catch`-Blöcke gibt es **nicht**.\n\n## Do\n```ts\nthrow new InvoiceError(id);\n```\n');
  write(d, 'rules/architecture/README.md', '# Muster\n\n| ID | Muster | Kurz |\n|---|---|---|\n| `modular-monolith` | [Modularer Monolith](modularer-monolith.md) | Ein Deployment, klare Modulgrenzen |\n');
  write(d, 'rules/architecture/modularer-monolith.md', '# Modularer Monolith\n\nEin Deployment.\n');
  write(d, 'rules/architecture/adr-vorlage.md', '# ADR\n');
  write(d, 'schema/profile.schema.json', JSON.stringify({ type: 'object', required: ['version', 'project'] }));
  write(d, 'profiles/platform/index.json', JSON.stringify([{ id: 'github-docker', name: 'GitHub + Docker', status: 'belegt' }, { id: 'gitlab', name: 'GitLab', status: 'vorschau' }]));
  write(d, 'plugins/kette-engineering-core/skills/engineering-rules/SKILL.md', 'x');
  write(d, 'plugins/kette-engineering-core/skills/architecture-patterns/SKILL.md', 'x');
  for (const s of ['ui-laws', 'interaction-principles', 'a11y-standards']) write(d, `plugins/ui-gesetze/skills/${s}/SKILL.md`, 'x');
  if (profiles) {
    write(d, 'profiles/stack/README.md', '| ID | Datei | Einsatz |\n|---|---|---|\n| `nestjs-prisma` | [nestjs-prisma.md](nestjs-prisma.md) | Backend mit relationalen Daten |\n');
    write(d, 'profiles/stack/nestjs-prisma.md', '# Stack: NestJS + Prisma\n');
    write(d, 'profiles/platform/github-docker/profile.md', '# Profil: GitHub + Docker\n');
    write(d, 'profiles/platform/gitlab/profile.md', '# Profil: GitLab\n');
    write(kh, 'credentials', JSON.stringify({ key: 'CDP-AAAAA-BBBBB-CCCCC-00001' }));
  }
  const state = path.join(kh, 'state.json');
  const prev = fs.existsSync(state) ? JSON.parse(fs.readFileSync(state, 'utf8')) : {};
  fs.writeFileSync(state, JSON.stringify({ ...prev, [`bundle_${tier}`]: { version: VERSION, dir: d } }));
  return d;
}

beforeEach(() => {
  kh = tmp();
  process.env.KETTE_HOME = kh;
});

const run = (...argv) => capture(() => main(argv));

test('rules ohne Thema zeigt Edition, Version, Kern-Regeln und Muster, in Community mit Hinweis auf Enterprise', async () => {
  rulebook('community');
  const { result, out } = await run('rules');
  assert.equal(result, 0);
  assert.match(out, new RegExp(`Edition Community, Version ${VERSION}`));
  assert.match(out, /lesbarkeit\s+Code wird öfter gelesen als geschrieben\.\n/);
  assert.match(out, /fehler\s+Leere catch-Blöcke gibt es nicht\./);
  assert.match(out, /modular-monolith\s+Modularer Monolith: Ein Deployment, klare Modulgrenzen/);
  assert.match(out, /Stack- und Plattform-Profile gibt es in Enterprise/);
  assert.doesNotMatch(out, /Plattform-Profile\n/);
});

test('rules in Enterprise zeigt Stack- und Plattform-Profile mit Status', async () => {
  rulebook('enterprise', { profiles: true });
  const { out } = await run('rules');
  assert.match(out, /Edition Enterprise \(Die Kette\)/);
  assert.match(out, /nestjs-prisma\s+Backend mit relationalen Daten/);
  assert.match(out, /github-docker\s+GitHub \+ Docker, belegt/);
  assert.match(out, /gitlab\s+GitLab, vorschau/);
});

test('rules <thema> zeigt die Regel lesbar, Code eingerückt, ohne Markdown-Zeichen', async () => {
  rulebook('community');
  const { result, out } = await run('rules', 'fehler');
  assert.equal(result, 0);
  assert.equal(out, 'FEHLER\n\nRegeln\n  - Leere catch-Blöcke gibt es nicht.\n\nDo\n    throw new InvoiceError(id);');
  assert.match((await run('rules', 'modular-monolith')).out, /^MODULARER MONOLITH\n\nEin Deployment\.$/);
  assert.match((await run('rules', 'modularer-monolith')).out, /^MODULARER MONOLITH/);
});

test('rules --path zeigt Dateipfade statt Inhalt', async () => {
  const d = rulebook('community');
  assert.equal((await run('rules', 'fehler', '--path')).out, path.join(d, 'rules', 'core', '03-fehler.md'));
  const all = (await run('rules', '--path')).out.split('\n');
  assert.equal(all[0], d);
  assert.ok(all.includes(path.join(d, 'rules', 'architecture', 'modularer-monolith.md')));
});

test('rules mit unbekanntem Thema nennt ähnliche Themen', async () => {
  rulebook('community');
  await assert.rejects(run('rules', 'fehlr'), /Unbekanntes Thema "fehlr"\. Meinten Sie: fehler\? Alle Themen: kette rules/);
  await assert.rejects(run('rules', 'quantenphysik'), (err) => !/Meinten Sie/.test(err.message) && /Alle Themen: kette rules/.test(err.message));
});

test('rules mit einem Enterprise-Profil in Community verweist auf kette login', async () => {
  rulebook('community');
  await assert.rejects(run('rules', 'github-docker'), /Profil aus Enterprise \(Die Kette\), freischalten mit: kette login <key>/);
  await assert.rejects(run('rules', 'nestjs-prisma'), /Profil aus Enterprise/);
});

test('rules in Enterprise liest Stack- und Plattform-Profile', async () => {
  rulebook('enterprise', { profiles: true });
  assert.match((await run('rules', 'github-docker')).out, /^PROFIL: GITHUB \+ DOCKER/);
  assert.match((await run('rules', 'nestjs-prisma')).out, /^STACK: NESTJS \+ PRISMA/);
});

test('rules ohne installiertes Regelwerk nennt den nächsten Schritt', async () => {
  await assert.rejects(run('rules'), /Kein Regelwerk auf diesem Rechner\. Laden mit: kette init .*kette update/);
});

test('init endet mit Zusammenfassung, .kette/README.md beschreibt den Ablauf der Community-Edition', async () => {
  rulebook('community');
  const root = path.join(tmp(), 'neu');
  const { result, out } = await run('init', root, '--yes', '--no-plugins');
  assert.equal(result, 0);
  const tail = out.slice(out.indexOf('Fertig.'));
  assert.match(tail, /^Fertig\. Im Projekt: \.kette\/profile\.json, \.kette\/README\.md, CLAUDE\.md, docs\/adr\/0000-vorlage\.md\n/);
  assert.match(tail, /In Claude Code noch nicht aktiv \(Plugins: kette-engineering-core@kette \(Skills architecture-patterns, engineering-rules\), ui-gesetze@kette \(Skills a11y-standards, interaction-principles, ui-laws\)\)/);
  assert.match(tail, /ansehen mit: kette rules/);
  assert.match(tail, /1\. kette doctor\n  2\. Claude Code im Projekt öffnen .*\n  3\. kette login <key>/);
  assert.ok(tail.split('\n').length <= 10);
  assert.doesNotMatch(out, /[\u2013\u2014]/);
  const note = fs.readFileSync(path.join(root, '.kette', 'README.md'), 'utf8');
  assert.match(note, /^<!-- kette:begin [^\n]*-->\n# Kette\n/);
  assert.match(note, /<!-- kette:end -->\n$/);
  assert.match(note, /## Ablauf für jede Änderung\n1\. Vor dem Bau: das Architektur-Muster wählen/);
  assert.match(note, /Selbstprüfung.*`ui-laws`, `interaction-principles` und `a11y-standards`/);
  assert.match(note, /Agenten .* gibt es mit Die Kette \(Edition Enterprise\): `kette login <key>`/);
  assert.doesNotMatch(note, /design-system-agents:/);
  assert.match(note, /## Wo die Regeln liegen/);
  assert.match(note, /~\/\.kette\/bundles\/active\//);
  assert.match(note, /In Claude Code die Plugins `kette-engineering-core@kette`, `ui-gesetze@kette`\./);
  assert.doesNotMatch(note, /[\u2013\u2014]/);
});

test('Enterprise: .kette/README.md schreibt Rollen, Pflicht-Gates und /feature-loop vor', async () => {
  const d = rulebook('enterprise', { profiles: true });
  for (const f of ['tsconfig.strict.json', 'eslint.config.mjs', 'dependency-cruiser.cjs', 'gitleaks.toml']) write(d, `checks/${f}`, 'x');
  const root = path.join(tmp(), 'neu');
  await run('init', root, '--yes', '--no-plugins', '--platform', 'gitlab');
  const note = fs.readFileSync(path.join(root, '.kette', 'README.md'), 'utf8');
  const order = ['design-system-agents:requirements-engineer', 'design-system-agents:software-architect', 'design-system-agents:fullstack-developer', 'kette-engineering:code-reviewer', 'design-system-agents:qa-engineer', 'design-review-pack:design-reviewer', 'design-system-agents:accessibility-manager'];
  const at = order.map((id) => note.indexOf(id));
  assert.ok(at.every((i, n) => i > 0 && (n === 0 || i > at[n - 1])), `Reihenfolge: ${at}`);
  assert.match(note, /Pflicht-Gates/);
  assert.match(note, /\/feature-loop start <Feature>/);
  assert.match(note, /apply, Deploy und zerstörende Migrationen führt ein Mensch aus/);
  assert.match(note, /Die Agenten, Gates und `\/feature-loop` brauchen Die Kette auf dem Rechner \(`kette login <key>`\)/);
  assert.match(note, /`design-system-agents@kette`, `design-review-pack@kette`\./);
  assert.doesNotMatch(note, /\d+ (Agenten|Skills|Befehle)/);
  assert.doesNotMatch(note, /[\u2013\u2014]/);
});

test('init nennt alle Plugins der Edition zum Einrichten von Hand, wenn Claude Code sie nicht übernimmt', { skip: process.platform === 'win32' }, async () => {
  rulebook('community');
  const claude = fakeClaude([{ name: 'kette', source: 'directory', path: '/repos/kette' }]);
  let out;
  try { ({ out } = await run('init', path.join(tmp(), 'neu'), '--yes')); } finally { claude.restore(); }
  assert.match(out, /Von Hand:\n  claude plugin marketplace add "[^"]+"\n  claude plugin install kette-engineering-core@kette\n  claude plugin install ui-gesetze@kette\n/);
});

test('add erneuert nur den Kette-Block, eigene Notizen bleiben', async () => {
  rulebook('community');
  const root = tmp();
  write(root, '.kette/README.md', '<!-- kette:begin alt -->\n# Kette\n\nalter Ablauf\n<!-- kette:end -->\n\n## Eigene Notizen\nBitte pnpm nutzen.\n');
  const cwd = process.cwd();
  process.chdir(root);
  try {
    const { out } = await run('add', '--yes', '--no-plugins');
    assert.match(out, /~ erneuern  \.kette\/README\.md/);
    assert.match(out, /\.kette\/README\.md \(erneuert\)/);
    const note = fs.readFileSync(path.join(root, '.kette', 'README.md'), 'utf8');
    assert.doesNotMatch(note, /alter Ablauf/);
    assert.match(note, /## Ablauf für jede Änderung/);
    assert.match(note, /<!-- kette:end -->\n\n## Eigene Notizen\nBitte pnpm nutzen\.\n$/);
    assert.match((await run('add', '--yes', '--no-plugins')).out, /= bleibt    \.kette\/README\.md/);
  } finally {
    process.chdir(cwd);
  }
});

test('add ersetzt eine unveränderte .kette/README.md aus 0.3.1, eine selbst geänderte ohne Block bleibt', async () => {
  rulebook('community');
  const legacy = fs.readFileSync(new URL('./fixtures/kette-readme-0.3.1.md', import.meta.url), 'utf8');
  const cwd = process.cwd();
  try {
    const old = tmp();
    write(old, '.kette/README.md', legacy);
    process.chdir(old);
    await run('add', '--yes', '--no-plugins');
    assert.match(fs.readFileSync(path.join(old, '.kette', 'README.md'), 'utf8'), /^<!-- kette:begin /);
    const own = tmp();
    write(own, '.kette/README.md', legacy + '\nEigene Zeile\n');
    process.chdir(own);
    const { out } = await run('add', '--yes', '--no-plugins');
    assert.match(out, /\.kette\/README\.md hat keinen Kette-Block und bleibt unverändert\. Neu erzeugen: eigene Notizen sichern, Datei löschen und kette add erneut ausführen/);
    assert.equal(fs.readFileSync(path.join(own, '.kette', 'README.md'), 'utf8'), legacy + '\nEigene Zeile\n');
  } finally {
    process.chdir(cwd);
  }
});

test('doctor listet je Plugin Agenten, Skills und Befehle aus dem Paket', async () => {
  const d = rulebook('community');
  write(d, 'plugins/ui-gesetze/commands/check.md', 'x');
  const project = tmp();
  const cwd = process.cwd();
  const claude = fakeClaude([], 'kette-engineering-core@kette\nui-gesetze@kette\n');
  process.chdir(project);
  try {
    const { out } = await run('doctor');
    assert.match(out, /OK {4}Plugin ui-gesetze@kette installiert/);
    assert.match(out, /INFO  Inhalt der Plugins:\n {8}kette-engineering-core@kette\n {10}Skills \(2\): architecture-patterns, engineering-rules\n {8}ui-gesetze@kette\n {10}Skills \(3\): a11y-standards, interaction-principles, ui-laws\n {10}Befehle \(1\): \/check/);
    assert.doesNotMatch((await run('doctor', '--ci')).out, /Inhalt der Plugins/);
  } finally {
    claude.restore();
    process.chdir(cwd);
  }
});

test('add hebt tier im Profil auf die Edition des Rechners an und schreibt den Enterprise-Ablauf, senkt nie', async () => {
  const d = rulebook('enterprise', { profiles: true });
  for (const f of ['tsconfig.strict.json', 'eslint.config.mjs', 'dependency-cruiser.cjs', 'gitleaks.toml']) write(d, `checks/${f}`, 'x');
  const root = tmp();
  write(root, '.kette/profile.json', JSON.stringify({ version: 1, project: { name: 'x' }, stack: ['nestjs-prisma'], platform: { id: 'gitlab' }, patterns: ['layered'], tier: 'community', eigen: true }, null, 2));
  const cwd = process.cwd();
  process.chdir(root);
  try {
    const { out } = await run('add', '--yes', '--no-plugins');
    assert.match(out, /~ erneuern  \.kette\/profile\.json/);
    const profile = JSON.parse(fs.readFileSync(path.join(root, '.kette', 'profile.json'), 'utf8'));
    assert.equal(profile.tier, 'enterprise');
    assert.equal(profile.eigen, true);
    assert.match(fs.readFileSync(path.join(root, '.kette', 'README.md'), 'utf8'), /kette-engineering:code-reviewer/);
  } finally {
    process.chdir(cwd);
  }
});

test('Community-Rechner lässt ein Enterprise-Projekt auf Enterprise, doctor nennt, was fehlt', async () => {
  rulebook('community');
  const root = tmp();
  write(root, '.kette/profile.json', JSON.stringify({ version: 1, project: { name: 'x' }, stack: ['nestjs-prisma'], platform: { id: 'gitlab' }, patterns: ['layered'], tier: 'enterprise' }));
  const cwd = process.cwd();
  process.chdir(root);
  try {
    await run('add', '--yes', '--no-plugins');
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.kette', 'profile.json'), 'utf8')).tier, 'enterprise');
    assert.match(fs.readFileSync(path.join(root, '.kette', 'README.md'), 'utf8'), /design-system-agents:requirements-engineer/);
    const { out } = await run('doctor', '--ci');
    assert.match(out, /HINW  Profil verlangt die Edition Enterprise .* Agenten, Gates, \/feature-loop, Plattform-Profile und Prüfungen aus \.kette\/README\.md fehlen/);
  } finally {
    process.chdir(cwd);
  }
});

test('doctor zeigt, wo Regelwerk und Plugins liegen', async () => {
  const d = rulebook('community');
  const { out } = await run('doctor', '--ci');
  assert.match(out, new RegExp(`INFO  Regelwerk und Plugins liegen in .*${path.basename(path.dirname(d))}`));
});
