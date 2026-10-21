# ADR-0001: Der Ablauf in .kette/README.md folgt der Edition des Projekts

- **Status:** angenommen
- **Datum:** 2026-10-21
- **Bezug:** Code-Review CR-ARCH-1, `src/note.mjs`, `src/cli.mjs`

## Kontext
`.kette/README.md` liegt im Repo und gilt für alle im Team. Bisher hing der Text vom Rechner ab, der zuletzt `kette init`, `add` oder `update` ausgeführt hat: Edition und Anzahl der Agenten, Skills und Befehle aus dem lokalen Paket. Ein Community-Rechner hätte so den Enterprise-Ablauf eines Teams überschrieben, und jede neue Paketversion hätte den Block geändert.

## Entscheidung
Der Block in `.kette/README.md` richtet sich nach `tier` in `.kette/profile.json` und enthält keine Zahlen. `kette init` setzt `tier` auf die Edition des Rechners. `kette add` hebt `tier` auf die Edition des Rechners an (Community auf Enterprise), senkt es aber nie. `kette update` erneuert den Block nach `tier`, ohne das Profil zu ändern. Der Enterprise-Ablauf sagt selbst, welche Teile Die Kette auf dem Rechner brauchen, und `kette doctor` warnt, wenn der Rechner eine niedrigere Edition hat als das Projekt.

## Betrachtete Alternativen
- Edition des Rechners: einfach, aber der Text im Repo wechselt je nach Person, die zuletzt einen Befehl ausführt.
- Zahlen im Block lassen: zeigt viel, ändert aber den Block bei jedem Paket und gehört in `kette doctor`.
- `tier` auch senken (z. B. nach `kette logout`): würde ein Teamprojekt durch einen einzelnen Rechner herabstufen.

## Folgen
Der Block bleibt stabil, bis jemand die Edition des Projekts bewusst ändert. Wer ohne Lizenz an einem Enterprise-Projekt arbeitet, sieht den Enterprise-Ablauf mit dem Hinweis, was fehlt. Zurück auf Community geht nur von Hand in `.kette/profile.json`. Neu prüfen, wenn es mehr als zwei Editionen gibt.
