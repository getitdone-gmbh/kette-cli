# Kette

Dieses Projekt folgt dem Regelwerk der Kette. Agenten lesen zuerst `.kette/profile.json`.

- Regeln in dieser Reihenfolge anwenden: Overlays der Firma, Plattform, Stack, Architektur-Muster, Kern.
- Skills: `engineering-rules`, `architecture-patterns`, in der Edition Enterprise (Die Kette) zusätzlich `platform-profile` und der Agent `code-reviewer`.
- Schwer umkehrbare Entscheidungen als ADR unter `docs/adr/` festhalten (Vorlage `docs/adr/0000-vorlage.md`).
- Eine Kern-Regel gilt, solange kein ADR sie ausdrücklich außer Kraft setzt.
- Infrastruktur nur als Code erzeugen und mit plan bzw. what-if prüfen. apply, Deploy und zerstörende Migrationen führt ein Mensch aus.

## Wo die Regeln liegen
- Auf diesem Rechner unter `~/.kette/bundles/active/`: `rules/core`, `rules/architecture`, in Enterprise auch `profiles/` und `checks/`.
- In Claude Code als Plugin `kette-engineering-core@kette` (Skills `engineering-rules`, `architecture-patterns`), in Enterprise zusätzlich `kette-engineering@kette` (`platform-profile`, `code-reviewer`).
- Ansehen mit `kette rules`, prüfen mit `kette doctor`.
