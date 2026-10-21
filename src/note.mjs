import crypto from 'node:crypto';
import { ENTERPRISE, pluginsFor } from './editions.mjs';
import { MARKETPLACE, pluginId } from './claude.mjs';

export const NOTE_PATH = '.kette/README.md';
const BEGIN = '<!-- kette:begin · Von kette erzeugt. kette update und kette add schreiben diesen Block neu, eigene Notizen gehören darunter. -->';
const END = '<!-- kette:end -->';
const BEGIN_MARK = '<!-- kette:begin';
const BEGIN_LINE = /<!-- kette:begin[^\n]*-->/;

// sha256 der unveränderten .kette/README.md aus den Versionen 0.1.0 bis 0.3.1 (ohne Block); nur diese Fassungen werden ganz ersetzt
const LEGACY_NOTES = new Set([
  '9d29307028209940a198faa1acdd947e771b6aff9b55d477e77577e2311203d2',
  '37787f48641a32d504233f936de68b0231aee1c1d63af153740f464b93e5aa6f',
  '6122c323462a10d8dbc9c071e915fc4cf51674507cdd4dda50af5799973e6695',
  '8e0d092ca26acd2c4b816d99e9b16d63cab5328ec6e5e5d58bd56ac8190dc127',
]);

const COMMON = `Dieses Projekt folgt dem Regelwerk der Kette. Agenten lesen zuerst \`.kette/profile.json\` und wenden Regeln in dieser Reihenfolge an: Overlays der Firma, Plattform, Stack, Architektur-Muster, Kern. Eine Kern-Regel gilt, solange kein ADR sie ausdrücklich außer Kraft setzt.`;

const ENTERPRISE_FLOW = `## Ablauf für jede Änderung
Kleine Korrekturen (Tippfehler, eine Zeile) direkt umsetzen und mit Schritt 4 prüfen. Alles andere läuft so, jede Rolle als eigener Subagent:

1. Anforderung: \`design-system-agents:requirements-engineer\` schreibt testbare Anforderungen mit IDs.
2. Architektur: \`design-system-agents:software-architect\` wählt das Muster (Skill \`architecture-patterns\`), schneidet Module und Schnittstellen und hält schwer umkehrbare Entscheidungen als ADR unter \`docs/adr/\` fest.
3. Umsetzung: \`design-system-agents:fullstack-developer\` baut in kleinen, getesteten Schritten nach \`engineering-rules\` und \`platform-profile\`.
4. Pflicht-Gates, unabhängig von der Umsetzung:
   - \`kette-engineering:code-reviewer\` prüft den Diff gegen Kern-Regeln, Muster und Projektprofil.
   - \`design-system-agents:qa-engineer\` prüft jede Anforderung mit Belegen.
   - Bei Änderungen an der Oberfläche zusätzlich \`design-review-pack:design-reviewer\`, und wo Tastatur, Kontrast, Fokus oder Screenreader betroffen sind, \`design-system-agents:accessibility-manager\`.
5. Befunde gehen an die Rolle, die sie verursacht hat (Skill \`evidence-and-defect-routing\`), danach prüft das Gate erneut. Fertig ist eine Änderung erst, wenn alle Gates bestanden sind.

Ein ganzes Feature mit allen Rollen, Fix-Schleife und Laufprotokoll: \`/feature-loop start <Feature>\` (in Claude Code \`/design-system-agents:feature-loop\`).

Die Agenten, Gates und \`/feature-loop\` brauchen Die Kette auf dem Rechner (\`kette login <key>\`). Fehlen sie, gelten Muster und ADR, \`engineering-rules\` beim Bau und die Prüfung mit \`kette-engineering-core:kette-check\`, und \`kette doctor\` zeigt, was fehlt.

Infrastruktur nur als Code erzeugen und mit plan bzw. what-if prüfen. apply, Deploy und zerstörende Migrationen führt ein Mensch aus.`;

const COMMUNITY_FLOW = `## Ablauf für jede Änderung
1. Vor dem Bau: das Architektur-Muster wählen (Skill \`architecture-patterns\`, im Profil unter \`patterns\`) und schwer umkehrbare Entscheidungen als ADR unter \`docs/adr/\` festhalten (Vorlage \`docs/adr/0000-vorlage.md\`).
2. Beim Bau: Skill \`engineering-rules\` laden und danach arbeiten (Lesbarkeit, Struktur, Fehler, Tests, Sicherheit, Abhängigkeiten, Logging, Änderungen).
3. Nach der Umsetzung prüfen: den Subagenten \`kette-engineering-core:kette-check\` den Diff gegen die Kern-Regeln und das gewählte Muster prüfen lassen, jeden Befund beheben und erneut prüfen lassen. Bei Änderungen an der Oberfläche zusätzlich gegen die Skills \`ui-laws\`, \`interaction-principles\` und \`a11y-standards\` prüfen.
4. Fertig ist eine Änderung, wenn Tests für neue Logik, Typprüfung und Lint grün sind, kein Befund von \`kette-check\` offen ist, jede schwer umkehrbare Entscheidung ein ADR hat und Infrastruktur nur als Code entstanden ist. apply, Deploy und zerstörende Migrationen führt ein Mensch aus.

Agenten für Anforderung, Architektur und Umsetzung sowie unabhängige Gates (Code-Reviewer, QA, Design-Review) gibt es mit Die Kette (Edition Enterprise): \`kette login <key>\`.`;

// Text für .kette/README.md je Edition des Projekts (profile.tier), zwischen den Markierungen, damit nur dieser Block erneuert wird
// Ohne Zahlen und Rechnerzustand, weil die Datei im Repo liegt und für alle im Team gleich bleiben soll
export function agentNote(tier) {
  const enterprise = tier === ENTERPRISE;
  const where = enterprise ? '`rules/`, `profiles/`, `checks/`' : '`rules/core`, `rules/architecture`';
  return `${BEGIN}
# Kette

${COMMON}

${enterprise ? ENTERPRISE_FLOW : COMMUNITY_FLOW}

## Wo die Regeln liegen
- Auf diesem Rechner unter \`~/.kette/bundles/active/\`: ${where}.
- In Claude Code die Plugins ${pluginsFor(tier).map((p) => `\`${pluginId(p, MARKETPLACE)}\``).join(', ')}.
- Ansehen mit \`kette rules\`, Inhalt der Plugins und Prüfung mit \`kette doctor\`.
${END}
`;
}

const count = (text, mark) => text.split(mark).length - 1;

// Neuer Dateiinhalt mit erneuertem Block; null, wenn die Markierungen nicht genau einmal und in richtiger Reihenfolge stehen
// und die Datei keine unveränderte alte Fassung ist. Nutzt die Datei CRLF, bekommt der neue Block CRLF; Zeilen außerhalb bleiben Byte für Byte
export function renewNote(current, note) {
  const block = current.includes('\r\n') ? note.replace(/\n/g, '\r\n') : note;
  if (count(current, BEGIN_MARK) === 1 && count(current, END) === 1) {
    const begin = current.search(BEGIN_LINE);
    const end = current.indexOf(END);
    if (begin < 0 || begin > end) return null;
    const rest = current.slice(end + END.length);
    const eol = rest.startsWith('\r\n') ? 2 : rest.startsWith('\n') ? 1 : 0;
    return current.slice(0, begin) + block + rest.slice(eol);
  }
  if (count(current, BEGIN_MARK) || count(current, END)) return null;
  const normalized = current.replace(/\r\n/g, '\n');
  return LEGACY_NOTES.has(crypto.createHash('sha256').update(normalized).digest('hex')) ? block : null;
}
