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
| Plugin `ui-gesetze@kette`: UI-Gesetze, Interaktion, WCAG 2.2 AA (3 Skills) | ja | im Design-Review-Pack enthalten |
| Ablauf in `.kette/README.md` | Muster und ADR, Regeln beim Bau, Prüfung mit dem Agenten `kette-check`, Definition of Done | Rollen als Subagenten, Pflicht-Gates, `/feature-loop` |
| Stack- und Plattform-Profile | | ja |
| Vorlagen für CI, Docker und Deploy, Prüfungen (tsconfig, ESLint, dependency-cruiser, gitleaks) | | ja |
| Plugin `kette-engineering@kette` mit Code-Reviewer | | ja |
| Plugin `design-system-agents@kette`: Agenten, Skills und Befehle für den ganzen Feature-Ablauf | | ja |
| Plugin `design-review-pack@kette`: Design-Reviewer mit Regelwerk | | ja |
| Bezug | frei, ohne Schlüssel | mit Lizenzschlüssel der Kette (Solo oder Team), `kette login <key>` |
| Updates | jederzeit | 12 Monate ab Kauf, die installierte Version bleibt dauerhaft nutzbar |

Im Projektprofil steht die Edition im Feld `tier`: `community` oder `enterprise`. Die Werte `free` und `kette` aus Version 0.1.0 werden weiter gelesen, `kette doctor` weist auf den neuen Namen hin.

## Befehle
| Befehl | Zweck |
|---|---|
| `kette init [ordner]` | neues Projekt: Profil, Agenten-Hinweise, ADR-Vorlage, Plugins; in Enterprise auch CI-, Docker- und Prüfvorlagen. Endet mit einer Zusammenfassung: was im Projekt entstand, was in Claude Code aktiv ist, nächste Schritte |
| `kette add` | bestehendes Repo anbinden: erkennt Stack und Plattform, überschreibt nichts außer dem Kette-Block in `.kette/README.md`, zeigt den Plan |
| `kette doctor` | Projekt und Einrichtung prüfen, zeigt Edition, Version, Updates bis, wo Regelwerk und Plugins liegen und je Plugin die Agenten, Skills und Befehle; `--ci` für Pipelines, ohne Netz |
| `kette rules [thema]` | installierte Regeln ohne Netz: Übersicht mit Kern-Regeln und Architektur-Mustern, in Enterprise auch Stack- und Plattform-Profile mit Status; mit Thema die Regel lesen, z. B. `kette rules fehler`, `kette rules modular-monolith`; `--path` zeigt die Dateipfade |
| `kette update` | neues Regelwerk laden und Plugins aktualisieren (Community über das Manifest, Enterprise über den Lieferdienst); im Projekt auch den Kette-Block in `.kette/README.md` erneuern |
| `kette profile` | Projektprofil anzeigen |
| `kette login <key>` | Enterprise freischalten: Schlüssel prüfen, Paket laden und prüfen, Plugins installieren, npm-Zugang für die Design-System-Pakete in `~/.npmrc` eintragen |
| `kette logout` | Schlüssel, Enterprise-Paket und npm-Zugang von diesem Rechner entfernen, den npm-Token widerrufen (das Gerät gibt der Support frei) |
| `kette token ci create <name>` / `list` / `revoke <id>` | CI-Tokens für `npm ci` in Pipelines: Solo 2, Team 5, belegen kein Gerät, werden nur beim Erstellen angezeigt |
| `kette figma` | aktuelles Figma-Release der Kette laden, Prüfsummen prüfen, Import-Reihenfolge zeigen; `--out ordner` |

Optionen: `--dry-run`, `--yes`, `--stack a,b`, `--platform id`, `--patterns a,b`, `--no-plugins`, `--path`, `--no-npm`, `--npm-replace`, `--out ordner`.

## npm-Pakete des Design Systems (Enterprise)
`kette login` holt für dieses Gerät einen eigenen npm-Token und schreibt einen markierten Block in die Benutzer-npmrc (`NPM_CONFIG_USERCONFIG`, sonst `~/.npmrc`, Rechte 600):

```
# >>> kette: managed by kette login, removed by kette logout
@getitdone-gmbh:registry=https://npm.kette.itdone.de/
//npm.kette.itdone.de/:_authToken=kt_...
# <<< kette
```

`kette logout` widerruft den Token und entfernt nur diesen Block. Steht in der npmrc schon eine eigene `@getitdone-gmbh:registry`-Zeile, bleibt sie unangetastet und der Schritt entfällt; `--npm-replace` kommentiert sie aus, `kette logout` stellt sie wieder her. `kette init` und `kette add` schreiben in Enterprise-Projekten nur die Scope-Zeile in die Projekt-`.npmrc` (ohne Token, darf ins Repo). `kette update` stellt einen neuen Token aus, wenn der Block fehlt oder die Registry den Token ablehnt. `kette doctor` prüft Block, Token und ob ein Token in einer Datei im Git steht. Bis das Update am 30.11.2026 den npm-Paketzugang freischaltet, meldet `kette login` nur "npm-Paketzugang folgt mit dem Update bis 30.11.2026" und schreibt nichts in die npmrc; `kette update` holt den Zugang danach nach, `kette init` und `kette add` schreiben die Scope-Zeile erst dann.

Pipelines bekommen einen CI-Token (`kette token ci create "GitHub Actions"`) als Secret `KETTE_NPM_TOKEN`:

```yaml
- uses: actions/setup-node@v4
  with: { node-version: 22, registry-url: https://npm.kette.itdone.de/, scope: '@getitdone-gmbh' }
- run: npm ci
  env: { NODE_AUTH_TOKEN: ${{ secrets.KETTE_NPM_TOKEN }} }
```

GitLab und andere: `npm config set //npm.kette.itdone.de/:_authToken "$KETTE_NPM_TOKEN"` im Job. yarn berry: in `.yarnrc.yml` `npmScopes: { getitdone-gmbh: { npmRegistryServer: "https://npm.kette.itdone.de/", npmAuthToken: "${KETTE_NPM_TOKEN}" } }` (schreibt die CLI nicht).

## Wo die Regeln liegen
Im Projekt liegen nur wenige Dateien: `.kette/profile.json`, `.kette/README.md`, die Verweiszeile in `CLAUDE.md` und die ADR-Vorlage. Das Regelwerk selbst liegt auf dem Rechner unter `~/.kette/bundles/active/` und ist in Claude Code als Plugins aktiv: in Community `kette-engineering-core@kette` (Skills `engineering-rules`, `architecture-patterns`) und `ui-gesetze@kette`, in Enterprise `kette-engineering-core@kette`, `kette-engineering@kette` (`platform-profile`, `code-reviewer`), `design-system-agents@kette` und `design-review-pack@kette`. Ansehen mit `kette rules`, was jedes Plugin mitbringt zeigt `kette doctor`.

`.kette/README.md` beschreibt den Ablauf für Claude Code zwischen `<!-- kette:begin` und `<!-- kette:end -->`. `kette init`, `kette add` und `kette update` erneuern nur diesen Block, eigene Notizen darunter bleiben, Zeilenenden (LF oder CRLF) auch. Fehlt eine Markierung oder steht sie doppelt, bleibt die Datei unverändert. Eine unveränderte Fassung aus 0.1.0 bis 0.3.1 ohne Block wird ganz ersetzt, eine selbst geänderte bleibt, und die CLI sagt, wie sie neu entsteht.

Der Ablauf richtet sich nach `tier` im Projektprofil, nicht nach dem Rechner ([ADR-0001](docs/adr/0001-ablauf-folgt-profil.md)). `kette add` hebt `tier` auf die Edition des Rechners an, senkt es aber nie. Hat der Rechner eine niedrigere Edition als das Projekt, warnt `kette doctor`.

Beim Wechsel der Edition entfernt die CLI die Plugins, die die neue Edition nicht hat: `kette login` entfernt `ui-gesetze@kette` (die Skills stecken im Design-Review-Pack), `kette logout` die drei Enterprise-Plugins, bevor es auf das Community-Paket umschaltet. Ob ein Plugin entfernt ist, prüft die CLI an der Plugin-Liste. Enthält ein älteres Paket auf dem Rechner ein Plugin noch nicht, installiert sie die übrigen und nennt `kette update`. Ist das Agenten-Pack zusätzlich einzeln installiert (Marketplace `claude-design-agent-pack`), bleibt es unangetastet, und die CLI nennt die doppelten Plugins.

Der Marketplace der ausgelieferten Pakete heißt in Claude Code `kette`. Bis Version 0.3.0 hieß er `kette-engineering`. Zeigt ein alter `kette-engineering` in `~/.kette`, ersetzt die CLI ihn beim nächsten `kette init`, `add`, `update` oder `login`. Zeigt er auf ein Arbeitsrepo des Regelwerks, bleibt er, und die CLI nennt den Befehl zum Deaktivieren, falls Skills doppelt aktiv sind.

## Was der Installer tut
- Prüft Node.js 20 oder neuer, git und tar.
- Lädt `manifest.json` und die CLI vom Spiegel und prüft die SHA-256 aus dem Manifest. Passt sie nicht, bricht er ab.
- Entpackt die CLI nach `~/.kette/cli/<version>` und legt `~/.kette/bin/kette` an.
- Ergänzt den PATH: `install.sh` hängt `export PATH="$HOME/.kette/bin:$PATH"` an `~/.zshrc` (zsh), `~/.bashrc` (bash) oder sonst `~/.profile`, nur wenn die Zeile fehlt, und zeigt, was er geändert hat. `install.ps1` ergänzt den PATH des Benutzers.

## Was der Installer nicht tut
- Kein sudo, keine Änderungen außerhalb von `~/.kette` und der einen Zeile in der Shell-Startdatei.
- Keine Cloud-Aktionen, kein Deploy, keine Konten. Infrastruktur entsteht als Code im Repo.
- Kein Überschreiben vorhandener Dateien. `CLAUDE.md` bekommt höchstens eine Verweiszeile, die Projekt-`.npmrc` höchstens die Scope-Zeile, die Benutzer-npmrc nur den markierten Kette-Block.
- Keine Telemetrie. Der Lieferdienst sieht nur Schlüssel, Geräte-ID, CLI-Version und die IP-Adresse, und das nur bei `kette login`, `kette update`, `kette token` und `kette figma` in Enterprise.

## Entfernen
1. Falls eingeloggt: `kette logout` (entfernt auch den npm-Block aus `~/.npmrc`). Den Geräteplatz der Lizenz gibt nur der Support frei.
2. Plugins und Marketplace aus Claude Code entfernen:
   ```sh
   claude plugin uninstall design-review-pack@kette
   claude plugin uninstall design-system-agents@kette
   claude plugin uninstall kette-engineering@kette
   claude plugin uninstall ui-gesetze@kette
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
| `KETTE_REGISTRY` | `https://npm.kette.itdone.de/` | Registry für die Scope-Zeile, bis ein Login die Adresse vom Lieferdienst übernimmt |
| `NPM_CONFIG_USERCONFIG` | `~/.npmrc` | Benutzer-npmrc, in die `kette login` den Block schreibt (wie npm) |
| `KETTE_NO_MODIFY_PATH` | nicht gesetzt | `1` lässt die Shell-Startdatei unverändert, der Installer zeigt dann die Zeile zum Selbsteintragen |

## Veröffentlichen
`npm run release` baut lokal, ohne etwas zu veröffentlichen, aus `../kette-engineering` (oder `KETTE_ENGINEERING`) und den Plugins `ui-gesetze`, `design-system-agents`, `design-review-pack` aus `../claude-design-agent-pack` (oder `KETTE_AGENT_PACK`) nach `dist/`. Vom Agenten-Pack nimmt es den Stand des neuesten Tags `vX.Y.Z` aus Git, nicht den Arbeitsordner; `KETTE_AGENT_PACK_REF` wählt einen anderen Stand zum Testen. Die Version ist `0.<Datum>.<Commits kette-engineering plus Commits Agenten-Pack>`, die Pakete sind reproduzierbar: gleicher Inhalt ergibt auf demselben Build-System dieselbe Prüfsumme (zwischen macOS-tar und GNU tar kann sie abweichen, deshalb baut ein Release immer auf einem System). Liegt in `dist/` schon dieselbe Paketversion oder dieselbe CLI-Version mit anderem Inhalt, bricht das Skript ab und lässt `dist/` unverändert.
- `install.sh`, `install.ps1`, `manifest.json`, `kette-cli-<version>.tgz`, `kette-community-<version>.tgz` (öffentlich unter `https://kette.itdone.de/dl/`)
- Community-Paket: `kette-engineering-core`, `ui-gesetze`
- `private/kette-enterprise-<version>.tgz` mit `kette-engineering-core`, `kette-engineering`, `design-system-agents`, `design-review-pack` und `private/kette-enterprise.json` (`{version, sha256, published_at, agent_pack}`), nie öffentlich

`npm run release -- --publish-enterprise` lädt das Enterprise-Paket zusätzlich mit `gh release create` als Release `v<version>` in das private Repo `alexfriedl/kette-engineering`. Das Skript bricht ab, wenn das Repo nicht privat ist, kette-engineering offene Änderungen hat, der Commit nicht gepusht ist oder der Stand des Agenten-Packs kein Release-Tag ist. Ohne den Schalter zeigt es nur den Befehl.

## Lizenz
MIT, siehe [LICENSE](LICENSE). Die Enterprise-Inhalte der Kette stehen unter eigener Lizenz im Paket.
