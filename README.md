# kette-cli

Richtet das Regelwerk und die Agenten der Kette per Terminal ein.

```sh
curl -fsSL https://kette.itdone.de/install | sh          # macOS, Linux
irm https://kette.itdone.de/install.ps1 | iex              # Windows
```

## Editionen
| | Community | Enterprise (Die Kette) |
|---|---|---|
| Kern-Regeln und Architektur-Muster mit ADR-Vorlage | ja | ja |
| Projektprofil `.kette/profile.json` und `kette doctor` | ja | ja |
| Plugin `kette-engineering-core@kette` | ja | ja |
| Stack- und Plattform-Profile | | ja |
| Vorlagen für CI, Docker und Deploy, Prüfungen (tsconfig, ESLint, dependency-cruiser, gitleaks) | | ja |
| Plugin `kette-engineering@kette` mit Code-Reviewer | | ja |
| Bezug | frei, ohne Schlüssel | mit Lizenzschlüssel der Kette (Solo oder Team), `kette login <key>` |
| Updates | jederzeit | 12 Monate ab Kauf, die installierte Version bleibt dauerhaft nutzbar |

Im Projektprofil steht die Edition im Feld `tier`: `community` oder `enterprise`. Die Werte `free` und `kette` aus Version 0.1.0 werden weiter gelesen, `kette doctor` weist auf den neuen Namen hin.

## Befehle
| Befehl | Zweck |
|---|---|
| `kette init [ordner]` | neues Projekt: Profil, Agenten-Hinweise, ADR-Vorlage, Plugins; in Enterprise auch CI-, Docker- und Prüfvorlagen. Endet mit einer Zusammenfassung: was im Projekt entstand, was in Claude Code aktiv ist, nächste Schritte |
| `kette add` | bestehendes Repo anbinden: erkennt Stack und Plattform, überschreibt nichts, zeigt den Plan und weist auf eine veraltete `.kette/README.md` hin |
| `kette doctor` | Projekt und Einrichtung prüfen, zeigt Edition, Version, Updates bis und wo Regelwerk und Plugins liegen; `--ci` für Pipelines, ohne Netz |
| `kette rules [thema]` | installierte Regeln ohne Netz: Übersicht mit Kern-Regeln und Architektur-Mustern, in Enterprise auch Stack- und Plattform-Profile mit Status; mit Thema die Regel lesen, z. B. `kette rules fehler`, `kette rules modular-monolith`; `--path` zeigt die Dateipfade |
| `kette update` | neues Regelwerk laden und Plugins aktualisieren (Community über das Manifest, Enterprise über den Lieferdienst) |
| `kette profile` | Projektprofil anzeigen |
| `kette login <key>` | Enterprise freischalten: Schlüssel prüfen, Paket laden und prüfen, Plugins installieren |
| `kette logout` | Schlüssel und Enterprise-Paket von diesem Rechner entfernen (das Gerät gibt der Support frei) |

Optionen: `--dry-run`, `--yes`, `--stack a,b`, `--platform id`, `--patterns a,b`, `--no-plugins`, `--path`.

## Wo die Regeln liegen
Im Projekt liegen nur wenige Dateien: `.kette/profile.json`, `.kette/README.md`, die Verweiszeile in `CLAUDE.md` und die ADR-Vorlage. Das Regelwerk selbst liegt auf dem Rechner unter `~/.kette/bundles/active/` und ist in Claude Code als Plugin `kette-engineering-core@kette` aktiv (Skills `engineering-rules`, `architecture-patterns`), in Enterprise zusätzlich `kette-engineering@kette` (`platform-profile`, `code-reviewer`). Ansehen mit `kette rules`.

Der Marketplace der ausgelieferten Pakete heißt in Claude Code `kette`. Bis Version 0.3.0 hieß er `kette-engineering`. Zeigt ein alter `kette-engineering` in `~/.kette`, ersetzt die CLI ihn beim nächsten `kette init`, `add`, `update` oder `login`. Zeigt er auf ein Arbeitsrepo des Regelwerks, bleibt er, und die CLI nennt den Befehl zum Deaktivieren, falls Skills doppelt aktiv sind.

## Was der Installer tut
- Prüft Node.js 20 oder neuer, git und tar.
- Lädt `manifest.json` und die CLI vom Spiegel und prüft die SHA-256 aus dem Manifest. Passt sie nicht, bricht er ab.
- Entpackt die CLI nach `~/.kette/cli/<version>` und legt `~/.kette/bin/kette` an.
- Ergänzt den PATH: `install.sh` hängt `export PATH="$HOME/.kette/bin:$PATH"` an `~/.zshrc` (zsh), `~/.bashrc` (bash) oder sonst `~/.profile`, nur wenn die Zeile fehlt, und zeigt, was er geändert hat. `install.ps1` ergänzt den PATH des Benutzers.

## Was der Installer nicht tut
- Kein sudo, keine Änderungen außerhalb von `~/.kette` und der einen Zeile in der Shell-Startdatei.
- Keine Cloud-Aktionen, kein Deploy, keine Konten. Infrastruktur entsteht als Code im Repo.
- Kein Überschreiben vorhandener Dateien. `CLAUDE.md` bekommt höchstens eine Verweiszeile.
- Keine Telemetrie. Der Lieferdienst sieht nur Schlüssel, Geräte-ID, CLI-Version und die IP-Adresse, und das nur bei `kette login` und `kette update` in Enterprise.

## Entfernen
1. Falls eingeloggt: `kette logout`. Den Geräteplatz der Lizenz gibt nur der Support frei.
2. Plugins und Marketplace aus Claude Code entfernen:
   ```sh
   claude plugin uninstall kette-engineering@kette
   claude plugin uninstall kette-engineering-core@kette
   claude plugin marketplace remove kette
   ```
3. Ablage löschen: `rm -rf ~/.kette` (bzw. das Verzeichnis aus `KETTE_HOME`).
4. In der Shell-Startdatei (`~/.zshrc`, `~/.bashrc` oder `~/.profile`) die Zeile `# kette` und die PATH-Zeile darunter löschen. Windows: `~\.kette\bin` aus dem PATH des Benutzers entfernen.

Die Dateien im Projekt (`.kette/`, Verweiszeile in `CLAUDE.md`, ADR-Vorlage) bleiben, bis sie jemand löscht.

## Umgebungsvariablen
| Variable | Standard | Zweck |
|---|---|---|
| `KETTE_HOME` | `~/.kette` | Ablage für CLI, Pakete, Schlüssel (`credentials`, Rechte 600) und Geräte-ID |
| `KETTE_MIRROR` | `https://kette.itdone.de/dl` | Spiegel für Manifest, CLI und Community-Paket, z. B. für Firmen und Offline-Umgebungen |
| `KETTE_DELIVERY` | `https://app-kette-delivery-833790b5.itdone.cloud` | Lieferdienst für Enterprise (Vertrag: [docs/install-api.md](docs/install-api.md)) |
| `KETTE_NO_MODIFY_PATH` | nicht gesetzt | `1` lässt die Shell-Startdatei unverändert, der Installer zeigt dann die Zeile zum Selbsteintragen |

## Veröffentlichen
`npm run release` baut aus `../kette-engineering` (oder `KETTE_ENGINEERING`) nach `dist/`:
- `install.sh`, `install.ps1`, `manifest.json`, `kette-cli-<version>.tgz`, `kette-community-<version>.tgz` (öffentlich unter `https://kette.itdone.de/dl/`)
- `private/kette-enterprise-<version>.tgz` und `private/kette-enterprise.json` (`{version, sha256, published_at}`), nie öffentlich

`npm run release -- --publish-enterprise` lädt das Enterprise-Paket zusätzlich mit `gh release create` als Release `v<version>` in das private Repo `alexfriedl/kette-engineering`. Das Skript bricht ab, wenn das Repo nicht privat ist, kette-engineering offene Änderungen hat oder der Commit nicht gepusht ist. Ohne den Schalter zeigt es nur den Befehl.

## Lizenz
MIT, siehe [LICENSE](LICENSE). Die Enterprise-Inhalte der Kette stehen unter eigener Lizenz im Paket.
