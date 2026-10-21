import crypto from 'node:crypto';
import { ENTERPRISE, pluginSummary } from './editions.mjs';
import { MARKETPLACE } from './claude.mjs';

export const NOTE_PATH = '.kette/README.md';
const BEGIN = '<!-- kette:begin · Von kette erzeugt. kette update und kette add schreiben diesen Block neu, eigene Notizen gehören darunter. -->';
const END = '<!-- kette:end -->';
const BLOCK = /<!-- kette:begin[^\n]*-->[\s\S]*?<!-- kette:end -->\n?/;

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

Infrastruktur nur als Code erzeugen und mit plan bzw. what-if prüfen. apply, Deploy und zerstörende Migrationen führt ein Mensch aus.`;

const COMMUNITY_FLOW = `## Ablauf für jede Änderung
1. Vor dem Bau: das Architektur-Muster wählen (Skill \`architecture-patterns\`, im Profil unter \`patterns\`) und schwer umkehrbare Entscheidungen als ADR unter \`docs/adr/\` festhalten (Vorlage \`docs/adr/0000-vorlage.md\`).
2. Beim Bau: Skill \`engineering-rules\` laden und danach arbeiten (Lesbarkeit, Struktur, Fehler, Tests, Sicherheit, Abhängigkeiten, Logging, Änderungen).
3. Danach Selbstprüfung: den Diff Regel für Regel gegen \`engineering-rules\` und das gewählte Muster prüfen und Verstöße beheben. Bei Änderungen an der Oberfläche zusätzlich gegen die Skills \`ui-laws\`, \`interaction-principles\` und \`a11y-standards\`.
4. Fertig ist eine Änderung, wenn Tests für neue Logik, Typprüfung und Lint grün sind, kein Regelverstoß offen ist, jede schwer umkehrbare Entscheidung ein ADR hat und Infrastruktur nur als Code entstanden ist. apply, Deploy und zerstörende Migrationen führt ein Mensch aus.

Agenten für Anforderung, Architektur und Umsetzung sowie unabhängige Gates (Code-Reviewer, QA, Design-Review) gibt es mit Die Kette (Edition Enterprise): \`kette login <key>\`.`;

// Text für .kette/README.md je Edition, zwischen den Markierungen, damit nur dieser Block erneuert wird
export function agentNote(tier, bundleDir) {
  const enterprise = tier === ENTERPRISE;
  const where = enterprise ? '`rules/`, `profiles/`, `checks/`' : '`rules/core`, `rules/architecture`';
  return `${BEGIN}
# Kette

${COMMON}

${enterprise ? ENTERPRISE_FLOW : COMMUNITY_FLOW}

## Wo die Regeln liegen
- Auf diesem Rechner unter \`~/.kette/bundles/active/\`: ${where}.
- In Claude Code: ${pluginSummary(tier, MARKETPLACE, bundleDir)}.
- Ansehen mit \`kette rules\`, Inhalt der Plugins und Prüfung mit \`kette doctor\`.
${END}
`;
}

// Neuer Dateiinhalt mit erneuertem Block; null, wenn die Datei keinen Block hat und keine unveränderte alte Fassung ist
export function renewNote(current, note) {
  if (BLOCK.test(current)) return current.replace(BLOCK, () => note);
  if (LEGACY_NOTES.has(crypto.createHash('sha256').update(current).digest('hex'))) return note;
  return null;
}
