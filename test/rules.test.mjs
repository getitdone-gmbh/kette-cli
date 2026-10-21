import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { capture, tmp, write } from './helpers.mjs';
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

test('doctor zeigt, wo Regelwerk und Plugins liegen', async () => {
  const d = rulebook('community');
  const { out } = await run('doctor', '--ci');
  assert.match(out, new RegExp(`INFO  Regelwerk und Plugins liegen in .*${path.basename(path.dirname(d))}`));
});
