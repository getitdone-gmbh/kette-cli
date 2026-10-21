import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fetchManifest, installBundle, installedBundle, readState, setActiveBundle } from './manifest.mjs';
import { detectPlatform, detectStack } from './detect.mjs';
import { validate } from './validate.mjs';
import { describe, print, apply } from './plan.mjs';
import { ask, choose, confirm, close } from './prompt.mjs';
import { MARKETPLACE, hasClaude, installPlugins, installedPlugins, pluginId, pluginInstalled } from './claude.mjs';
import { activeBundleLink, credentialsFile, delivery, home, mirror } from './paths.mjs';
import { COMMUNITY, ENTERPRISE, editionLabel, isLegacyTier, normalizeProfile, pluginsFor, pluginSummary, isNewer } from './editions.mjs';
import { rules, tilde } from './rules.mjs';
import { credentialsStatus, formatDate, loginState, login, logout, tierOf, updateEnterprise } from './enterprise.mjs';

const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const STACKS = [
  { value: 'nextjs-ts-tailwind', label: 'Next.js + TypeScript + Tailwind (Web)' },
  { value: 'nestjs-prisma', label: 'NestJS + Prisma (Backend, relationale Daten)' },
  { value: 'nestjs-mongoose', label: 'NestJS + Mongoose (Backend, Dokumente)' },
  { value: 'python-fastapi', label: 'Python + FastAPI' },
  { value: 'react-native-expo', label: 'React Native + Expo (Mobile)' },
];
const PLATFORMS = [
  { value: 'github-docker', label: 'GitHub + Docker auf eigenem Server' },
  { value: 'aws-github', label: 'AWS + GitHub' },
  { value: 'azure-devops', label: 'Azure + Azure DevOps' },
  { value: 'gitlab', label: 'GitLab' },
  { value: 'oss-selfhosted', label: 'Open Source auf eigenen Servern' },
];
const PATTERNS = [
  { value: 'modular-monolith', label: 'Modularer Monolith (Standard)' },
  { value: 'layered', label: 'Schichten' },
  { value: 'hexagonal', label: 'Ports und Adapter' },
  { value: 'event-driven', label: 'Ereignisgesteuert mit Outbox' },
  { value: 'cqrs', label: 'CQRS' },
  { value: 'bff', label: 'Backend for Frontend' },
  { value: 'multi-tenant', label: 'Mandantenfähigkeit' },
];

// github-docker: Vorlage im Paket -> Ziel im Projekt
const PLATFORM_FILES = {
  'github-docker': [
    ['ci.yml', '.github/workflows/ci.yml'],
    ['deploy.yml', '.github/workflows/deploy.yml'],
    ['Dockerfile.api', 'apps/api/Dockerfile'],
    ['prune-runtime.mjs', 'apps/api/scripts/prune-runtime.mjs'],
    ['Dockerfile.web', 'apps/web/Dockerfile'],
    ['playwright.config.ts', 'apps/web/playwright.config.ts'],
    ['compose.yaml', 'compose.yaml'],
    ['DEPLOY.md', 'DEPLOY.md'],
  ],
};
const CHECK_FILES = [
  ['tsconfig.strict.json', 'tsconfig.base.json'],
  ['eslint.config.mjs', 'eslint.config.mjs'],
  ['dependency-cruiser.cjs', '.dependency-cruiser.cjs'],
  ['gitleaks.toml', '.gitleaks.toml'],
];

const HELP = `kette ${VERSION} · Regelwerk und Agenten der Kette einrichten

Befehle:
  kette init [ordner]   Neues Projekt mit Profil, Regeln und Agenten anlegen
  kette add             Bestehendes Repo an die Kette anbinden (erkennt Stack und Plattform)
  kette doctor          Projekt und Einrichtung prüfen (--ci für Pipelines)
  kette update          Neueste Version des Regelwerks laden
  kette rules [thema]   Installierte Regeln zeigen, mit Thema die Regel lesen (--path für Dateipfade)
  kette profile         Projektprofil anzeigen
  kette login <key>     Enterprise (Die Kette) freischalten: Plattform-Profile, Prüfungen, Code-Reviewer
  kette logout          Lizenzschlüssel und Enterprise-Paket von diesem Rechner entfernen
  kette version

Optionen:
  --dry-run             Nur zeigen, nichts schreiben
  --yes                 Keine Rückfragen, Standardwerte oder Angaben aus den Optionen nutzen
  --stack a,b           Stacks festlegen
  --platform id         Plattform festlegen
  --patterns a,b        Muster festlegen
  --no-plugins          Claude-Code-Plugins nicht installieren
  --path                Bei kette rules die Dateipfade statt des Inhalts zeigen

Der Installer legt nie Cloud-Ressourcen an und deployt nichts. Infrastruktur entsteht als Code im Repo.`;

function parse(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--yes' || a === '-y') opts.yes = true;
    else if (a === '--no-plugins') opts.noPlugins = true;
    else if (a === '--ci') opts.ci = true;
    else if (a === '--path') opts.path = true;
    else if (['--stack', '--platform', '--patterns', '--name'].includes(a)) opts[a.slice(2)] = argv[++i];
    else if (a === '--help' || a === '-h') opts.help = true;
    else opts._.push(a);
  }
  return opts;
}

const listArg = (s) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : null);

async function ensureBundle(tier) {
  const have = installedBundle(tier);
  if (have) return have.dir;
  console.log(`Lade Regelwerk (${editionLabel(tier)}) von ${mirror()} ...`);
  return installBundle(await fetchManifest(), tier);
}

function loadSchema(bundleDir) {
  return JSON.parse(fs.readFileSync(path.join(bundleDir, 'schema', 'profile.schema.json'), 'utf8'));
}

async function buildProfile(root, opts, detected) {
  const name = opts.name || path.basename(path.resolve(root));
  let stack = listArg(opts.stack) || detected.stack;
  let platform = opts.platform || detected.platform;
  let patterns = listArg(opts.patterns);
  if (!opts.yes) {
    if (!listArg(opts.stack)) {
      const def = stack.length ? stack.map((s) => STACKS.findIndex((x) => x.value === s) + 1).join(',') : '1,2';
      stack = await choose('Welche Stacks nutzt das Projekt?', STACKS, def);
    }
    if (!opts.platform) {
      const def = String((PLATFORMS.findIndex((x) => x.value === platform) + 1) || 1);
      [platform] = await choose('Wo wird gebaut und betrieben?', PLATFORMS, def);
    }
    if (!patterns) patterns = await choose('Welche Architektur-Muster? (im Zweifel 1)', PATTERNS, '1');
  }
  return {
    $schema: 'https://kette.itdone.de/schema/profile.schema.json',
    version: 1,
    project: { name },
    stack: stack.length ? stack : ['nextjs-ts-tailwind', 'nestjs-prisma'],
    platform: { id: platform || 'github-docker' },
    patterns: patterns?.length ? patterns : ['modular-monolith'],
    tier: tierOf(),
  };
}

function agentNote() {
  return `# Kette

Dieses Projekt folgt dem Regelwerk der Kette. Agenten lesen zuerst \`.kette/profile.json\`.

- Regeln in dieser Reihenfolge anwenden: Overlays der Firma, Plattform, Stack, Architektur-Muster, Kern.
- Skills: \`engineering-rules\`, \`architecture-patterns\`, in der Edition Enterprise (Die Kette) zusätzlich \`platform-profile\` und der Agent \`code-reviewer\`.
- Schwer umkehrbare Entscheidungen als ADR unter \`docs/adr/\` festhalten (Vorlage \`docs/adr/0000-vorlage.md\`).
- Eine Kern-Regel gilt, solange kein ADR sie ausdrücklich außer Kraft setzt.
- Infrastruktur nur als Code erzeugen und mit plan bzw. what-if prüfen. apply, Deploy und zerstörende Migrationen führt ein Mensch aus.

## Wo die Regeln liegen
- Auf diesem Rechner unter \`~/.kette/bundles/active/\`: \`rules/core\`, \`rules/architecture\`, in Enterprise auch \`profiles/\` und \`checks/\`.
- In Claude Code als Plugin \`kette-engineering-core@kette\` (Skills \`engineering-rules\`, \`architecture-patterns\`), in Enterprise zusätzlich \`kette-engineering@kette\` (\`platform-profile\`, \`code-reviewer\`).
- Ansehen mit \`kette rules\`, prüfen mit \`kette doctor\`.
`;
}

function planFor(root, profile, bundleDir, tier) {
  const plan = [
    { path: '.kette/profile.json', content: JSON.stringify(profile, null, 2) + '\n' },
    { path: '.kette/README.md', content: agentNote() },
    { path: 'CLAUDE.md', mode: 'append', marker: '@.kette/README.md', content: '@.kette/README.md\n', note: 'Verweis auf die Kette-Regeln' },
    { path: 'docs/adr/0000-vorlage.md', content: fs.readFileSync(path.join(bundleDir, 'rules', 'architecture', 'adr-vorlage.md'), 'utf8') },
  ];
  if (tier === ENTERPRISE) {
    const tpl = path.join(bundleDir, 'profiles', 'platform', profile.platform.id, 'templates');
    for (const [from, to] of PLATFORM_FILES[profile.platform.id] || []) {
      const src = path.join(tpl, from);
      if (fs.existsSync(src)) plan.push({ path: to, content: fs.readFileSync(src, 'utf8'), note: 'Vorlage, Platzhalter OWNER/REPO und app anpassen' });
    }
    for (const [from, to] of CHECK_FILES) {
      plan.push({ path: to, content: fs.readFileSync(path.join(bundleDir, 'checks', from), 'utf8'), note: 'Prüfung' });
    }
  }
  return plan;
}

function platformStatus(bundleDir, id) {
  const f = path.join(bundleDir, 'profiles', 'platform', 'index.json');
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, 'utf8')).find((p) => p.id === id)?.status || null;
}

async function setup(root, opts, isNew) {
  const tier = tierOf();
  const bundleDir = await ensureBundle(tier);
  if (isNew) fs.mkdirSync(root, { recursive: true });
  const detected = isNew ? { stack: [], platform: null } : { stack: detectStack(root), platform: detectPlatform(root) };
  if (!isNew) console.log(`Erkannt: Stack ${detected.stack.join(', ') || 'keiner'}, Plattform ${detected.platform || 'keine'}`);
  const profile = await buildProfile(root, opts, detected);
  const errors = validate(loadSchema(bundleDir), profile);
  if (errors.length) throw new Error(`Profil ungültig: ${errors.join('; ')}`);

  const described = describe(planFor(root, profile, bundleDir, tier), root);
  console.log(`\n${opts.dryRun ? 'Würde anlegen' : 'Plan'} in ${path.resolve(root)} (Edition ${editionLabel(tier)}):`);
  print(described);
  const stale = staleNote(described, root);
  if (stale) console.log(stale);
  if (tier === COMMUNITY) console.log('\n  Plattform-Vorlagen, Prüfungen und Code-Reviewer gibt es in der Edition Enterprise (Die Kette): kette login <key>');
  else if (!PLATFORM_FILES[profile.platform.id]) console.log(`\n  Für ${profile.platform.id} gibt es noch keine Vorlagen (Status: ${platformStatus(bundleDir, profile.platform.id) || 'unbekannt'}).`);
  if (opts.dryRun) return 0;
  if (!(await confirm('\nSo anlegen?', opts.yes))) { console.log('Abgebrochen, nichts geschrieben.'); return 1; }

  if (isNew && !fs.existsSync(path.join(root, '.git'))) spawnSync('git', ['init', '-q', root]);
  apply(described, root);

  let plugins = { ok: false, reason: 'mit --no-plugins übersprungen' };
  let rulesDir = bundleDir;
  if (!opts.noPlugins) {
    rulesDir = setActiveBundle(bundleDir);
    plugins = installPlugins(rulesDir, pluginsFor(tier));
    if (!plugins.ok) console.log(`Plugins nicht installiert (${plugins.reason}). Von Hand: claude plugin marketplace add ${rulesDir} && claude plugin install ${pluginId('kette-engineering-core')}`);
  }
  console.log(summary(described, tier, plugins.ok, rulesDir));
  return 0;
}

const README_ITEM = '.kette/README.md';

// Hinweis, wenn eine vorhandene .kette/README.md nicht der aktuellen Fassung entspricht; sie wird nie überschrieben
function staleNote(described, root) {
  const note = described.find((d) => d.path === README_ITEM);
  if (note?.action !== 'vorhanden' || fs.readFileSync(path.join(root, README_ITEM), 'utf8') === note.content) return null;
  return `  ${README_ITEM} weicht von der aktuellen Fassung ab (z. B. ohne „Wo die Regeln liegen“). Neu erzeugen: Datei löschen und kette add erneut ausführen.`;
}

// Kurzer Abschluss: was im Projekt entstand, was auf dem Rechner aktiv ist, wie es weitergeht
function summary(described, tier, pluginsOk, rulesDir) {
  const changed = described.filter((d) => d.action !== 'vorhanden').map((d) => (d.action === 'ergänzen' ? `${d.path} (ergänzt)` : d.path));
  const steps = ['kette doctor', 'Claude Code im Projekt öffnen und fragen: "Prüfe diesen Code gegen die Kette-Regeln"'];
  if (tier === COMMUNITY) steps.push('kette login <key> für Profile, Prüfungen und Code-Reviewer (Enterprise)');
  return [
    '',
    `Fertig. Im Projekt: ${changed.length ? changed.join(', ') : 'nichts geändert, alles schon vorhanden'}`,
    pluginsOk ? `Regeln aktiv in Claude Code: ${pluginSummary(tier, MARKETPLACE)}` : `Regeln in Claude Code noch nicht aktiv (Plugins: ${pluginSummary(tier, MARKETPLACE)})`,
    `Regelwerk auf diesem Rechner: ${tilde(rulesDir)}, ansehen mit: kette rules`,
    'Nächste Schritte:',
    ...steps.map((s, i) => `  ${i + 1}. ${s}`),
  ].join('\n');
}

function readProfile(root) {
  const f = path.join(root, '.kette', 'profile.json');
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

function tool(cmd, args = ['--version']) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return r.status === 0 ? (r.stdout || r.stderr).trim().split('\n')[0] : null;
}

async function doctor(root, opts) {
  let problems = 0;
  const line = (ok, msg) => { console.log(`${ok ? 'OK   ' : 'FEHLT'} ${msg}`); if (!ok) problems++; };
  const warn = (msg) => console.log(`HINW  ${msg}`);
  line(Number(process.versions.node.split('.')[0]) >= 20, `Node ${process.versions.node} (mindestens 20)`);
  line(Boolean(tool('git')), 'git vorhanden');
  if (!opts.ci) {
    const claude = hasClaude();
    if (claude) line(true, 'Claude Code vorhanden');
    else warn('Claude Code nicht gefunden, Agenten und Plugins brauchen es');
  }
  const tier = tierOf();
  const bundle = installedBundle(tier);
  edition(tier, { line, warn });
  line(Boolean(bundle), `Regelwerk installiert (${editionLabel(tier)}${bundle ? `, Version ${bundle.version}` : ''})`);
  if (bundle) console.log(`INFO  Regelwerk und Plugins liegen in ${tilde(fs.existsSync(activeBundleLink()) ? activeBundleLink() : bundle.dir)}`);
  const raw = readProfile(root);
  const profile = normalizeProfile(raw);
  line(Boolean(profile), '.kette/profile.json vorhanden');
  if (raw && isLegacyTier(raw.tier)) warn(`Profil nutzt den alten Wert tier "${raw.tier}", gelesen als "${profile.tier}". In .kette/profile.json auf "${profile.tier}" ändern.`);
  if (profile && bundle) {
    const errs = validate(loadSchema(bundle.dir), profile);
    line(errs.length === 0, `Profil gültig${errs.length ? `: ${errs.join('; ')}` : ''}`);
    const status = platformStatus(bundle.dir, profile.platform?.id);
    if (status === 'vorschau') warn(`Plattform ${profile.platform.id} ist noch Vorschau (ohne belegtes Referenzprojekt)`);
    if (profile.tier === ENTERPRISE && tier !== ENTERPRISE) warn('Profil verlangt die Edition Enterprise (Die Kette), hier ist nur Community installiert. Freischalten mit: kette login <key>');
    for (const o of profile.overlays || []) warn(`Overlay ${o.source} wird von Agenten geladen, hier nicht geprüft`);
  }
  if (!opts.ci && bundle && hasClaude()) {
    const list = installedPlugins();
    for (const p of pluginsFor(tier)) line(pluginInstalled(p, list), `Plugin ${pluginId(p)} installiert`);
  }
  const md = path.join(root, 'CLAUDE.md');
  if (profile) line(fs.existsSync(md) && fs.readFileSync(md, 'utf8').includes('@.kette/README.md'), 'CLAUDE.md verweist auf die Kette-Regeln');
  console.log(problems ? `\n${problems} Punkt(e) offen` : '\nalles in Ordnung');
  return problems ? 1 : 0;
}

async function update(opts) {
  if (credentialsStatus() === 'valid') return updateEnterprise(opts, VERSION);
  const manifest = await fetchManifest();
  const tier = COMMUNITY;
  const have = installedBundle(tier);
  if (have?.version === manifest.version) { console.log(`Aktuell (Version ${manifest.version}).`); return 0; }
  console.log(`Neue Version ${manifest.version}${have ? ` (installiert: ${have.version})` : ''}.`);
  if (manifest.changelog) console.log(manifest.changelog);
  if (opts.dryRun) return 0;
  const dir = await installBundle(manifest, tier);
  if (!opts.noPlugins) {
    const r = installPlugins(setActiveBundle(dir), pluginsFor(tier));
    if (!r.ok) console.log(`Plugins nicht aktualisiert (${r.reason}).`);
  }
  if (manifest.cli && isNewer(manifest.cli.version, VERSION)) console.log(`Neue CLI ${manifest.cli.version} verfügbar: curl -fsSL https://kette.itdone.de/install | sh`);
  console.log(`Regelwerk ${manifest.version} installiert.`);
  return 0;
}

// Edition ohne Netz aus Zugangsdaten und gespeichertem Login-Stand, damit doctor --ci offline bleibt
function edition(tier, { line, warn }) {
  const creds = credentialsStatus();
  if (creds === 'broken') line(false, `Zugangsdaten in ${credentialsFile()} beschädigt. Neu anmelden: kette logout && kette login <key>`);
  if (tier === COMMUNITY) {
    if (creds === 'valid') line(false, 'Lizenz hinterlegt, aber das Enterprise-Paket fehlt. Nachladen mit: kette update');
    else line(true, `Edition ${editionLabel(COMMUNITY)}`);
    return;
  }
  const state = loginState() || {};
  line(true, `Edition ${editionLabel(ENTERPRISE)}, Version ${installedBundle(ENTERPRISE).version}, Updates bis ${formatDate(state.updates_until)}`);
  if (state.updates_until && new Date(state.updates_until) < new Date()) warn(`Update-Zeitraum endete am ${formatDate(state.updates_until)}. Die installierte Version bleibt nutzbar, neue Versionen gibt es mit einer Verlängerung.`);
  if (process.platform !== 'win32' && (fs.statSync(credentialsFile()).mode & 0o077)) warn(`${credentialsFile()} ist für andere lesbar. Beheben mit: chmod 600 ${credentialsFile()}`);
}

export async function main(argv) {
  const opts = parse(argv);
  const [cmd, arg] = opts._;
  try {
    if (!cmd || opts.help || cmd === 'help') { console.log(HELP); return 0; }
    if (cmd === 'version' || cmd === '--version') { console.log(VERSION); return 0; }
    if (cmd === 'init') {
      const root = arg || (opts.yes ? '.' : await ask('Ordner für das neue Projekt', '.'));
      if (fs.existsSync(path.join(root, '.kette', 'profile.json'))) throw new Error(`${root} hat schon ein Kette-Profil, dafür kette add oder kette doctor nutzen`);
      return await setup(root, opts, !fs.existsSync(root) || fs.readdirSync(root).length === 0);
    }
    if (cmd === 'add') return await setup('.', opts, false);
    if (cmd === 'doctor') return await doctor('.', opts);
    if (cmd === 'update') return await update(opts);
    if (cmd === 'rules') {
      const tier = tierOf();
      return rules(arg, opts, { bundle: installedBundle(tier), tier, stackIds: STACKS.map((x) => x.value) });
    }
    if (cmd === 'profile') { const p = readProfile('.'); console.log(p ? JSON.stringify(p, null, 2) : 'Kein .kette/profile.json in diesem Ordner.'); return p ? 0 : 1; }
    if (cmd === 'login') return await login(arg, opts, VERSION);
    if (cmd === 'logout') return logout(opts);
    if (cmd === 'state') { console.log(JSON.stringify({ home: home(), mirror: mirror(), delivery: delivery(), ...readState() }, null, 2)); return 0; }
    console.error(`Unbekannter Befehl: ${cmd}\n`);
    console.log(HELP);
    return 1;
  } finally {
    close();
  }
}
