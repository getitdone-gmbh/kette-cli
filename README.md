# kette-cli

Richtet das Regelwerk und die Agenten der Kette per Terminal ein.

```sh
curl -fsSL https://kette.itdone.de/install | sh          # macOS, Linux
irm https://kette.itdone.de/install.ps1 | iex              # Windows
```

## Befehle
| Befehl | Zweck |
|---|---|
| `kette init [ordner]` | neues Projekt: Profil, Agenten-Hinweise, ADR-Vorlage, Plugins; mit Kette-Lizenz auch CI-, Docker- und Prüfvorlagen |
| `kette add` | bestehendes Repo anbinden: erkennt Stack und Plattform, überschreibt nichts, zeigt den Plan |
| `kette doctor` | Projekt und Einrichtung prüfen, `--ci` für Pipelines |
| `kette update` | neues Regelwerk laden und Plugins aktualisieren |
| `kette profile` | Projektprofil anzeigen |
| `kette login <key>` | Kette-Lizenz hinterlegen (folgt mit dem Lizenzweg in chain-delivery) |

Optionen: `--dry-run`, `--yes`, `--stack a,b`, `--platform id`, `--patterns a,b`, `--no-plugins`.

## Grundsätze
- Kein sudo, alles unter `~/.kette` (überschreibbar mit `KETTE_HOME`).
- Jeder Download wird gegen die SHA-256 aus dem Manifest geprüft.
- Vorhandene Dateien werden nie überschrieben, `CLAUDE.md` bekommt höchstens eine Verweiszeile.
- Keine Cloud-Aktionen, kein Deploy. Infrastruktur entsteht als Code im Repo.
- Eigene Spiegel für Firmen und Offline-Umgebungen über `KETTE_MIRROR`.

## Veröffentlichen
`npm run release` baut aus `../kette-engineering` (oder `KETTE_ENGINEERING`) nach `dist/`:
- `install.sh`, `install.ps1`, `manifest.json`, `kette-cli-<version>.tgz`, `kette-free-<version>.tgz` (öffentlich unter `https://kette.itdone.de/dl/`)
- `private/kette-kette-<version>.tgz` (nur über den Lizenzweg, nie öffentlich)
