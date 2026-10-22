# Install-API (Vertrag zwischen kette-cli und chain-delivery)

Stand 2026-10-21. Beide Seiten bauen gegen diesen Vertrag. Änderungen nur gemeinsam (chain-delivery Branch `feat/npm-registry`, kette-cli Branch `feat/npm-access`).

## Editionen
- **Community (frei):** öffentlich unter `https://kette.itdone.de/dl` (Manifest, CLI, Paket `kette-community-<version>.tgz`). Kein Schlüssel.
- **Enterprise (Die Kette):** Paket `kette-enterprise-<version>.tgz`, nur über diese API. In jeder Lizenzstufe der Kette enthalten (Solo und Team), kein eigenes Angebot.

## Lizenzschlüssel
Format `CDP-XXXXX-XXXXX-XXXXX-XXXXX` (wie heute in chain-delivery). Gültig für Angebote der Familie `kette` (kette-solo, kette-team).

## Geräte und Laufzeit
- Die CLI erzeugt beim ersten `kette login` eine zufällige Geräte-ID (UUID v4) und speichert sie in `~/.kette/device-id`.
- Grenzen: Solo 3 Geräte, Team (bis 10 Personen) 20 Geräte. Ein bekanntes Gerät zählt nicht neu.
- Updates 12 Monate ab Kauf (`updates_until`). Danach liefert die API die neueste Version, die vor `updates_until` veröffentlicht wurde. Die Nutzung bleibt dauerhaft erlaubt.

## Endpunkte (Basis: Lieferdienst, Standard `https://app-kette-delivery-833790b5.itdone.cloud`, in der CLI über `KETTE_DELIVERY` überschreibbar)

### POST /install/token
Anfrage (JSON): `{ "key": "CDP-…", "device": "<uuid>", "cli": "0.2.0" }`

Antworten:
- `200` `{ "edition": "enterprise", "version": "0.20261020.7", "url": "https://…/install/download/<token>", "sha256": "<hex>", "expires_at": "<ISO>", "updates_until": "<ISO>", "seats": { "used": 2, "max": 3 } }`
  - `url` ist ein signierter Link, 15 Minuten gültig, für genau diese Version.
- `400` `{ "error": "bad_request" }` (Format von key oder device falsch)
- `401` `{ "error": "invalid_key" }` (unbekannt)
- `403` `{ "error": "revoked" }` (widerrufen oder voll erstattet)
- `403` `{ "error": "wrong_offer" }` (Schlüssel gehört nicht zur Familie kette)
- `429` `{ "error": "device_limit", "seats": { "used": 3, "max": 3 } }`
- `503` `{ "error": "unavailable" }` (Paketquelle nicht erreichbar oder keine passende Version vorhanden)
- Begrenzung gegen Raten: höchstens 10 Anfragen pro Minute je Lizenzschlüssel; fehlgeschlagene Anfragen (bad_request, invalid_key) zählen zusätzlich mit höchstens 60 pro Minute je gemeldeter IP, dann `429 { "error": "rate_limited" }`. (Die Plattform liefert nur Node-Adressen, deshalb führt der Schlüssel.)

### GET /install/download/:token
Streamt das Paket (`application/gzip`). Abgelaufener oder falscher Token: `410` bzw. `404`.

### POST /install/latest
Anfrage (JSON): `{ "key": "CDP-…", "device": "<uuid>" }` (POST, damit der Schlüssel nicht in Zugriffslogs von Proxys landet; GET antwortet 405).

`200` `{ "version": "…" (neueste Version überhaupt), "available": "…", "updates_until": "…", "changelog": "…" }`. `available` ist die neueste Version, die dieser Schlüssel bekommt. Registriert kein neues Gerät (nur `/install/token` belegt Geräte). Gleiche Fehlercodes wie oben.

## npm-Registry (Design-System-Pakete)

Lesender npm-Proxy im Lieferdienst für genau vier Pakete aus GitHub Packages: `@getitdone-gmbh/kette-tokens`, `@getitdone-gmbh/kette-design-enterprise`, `@getitdone-gmbh/zero`, `@getitdone-gmbh/zero-pages`. Bis 2027-01-31 liefert er zusätzlich die alten Namen `@getitdone-gmbh/figma-design-tokens` und `@getitdone-gmbh/component-library-react` (Versionen vor der Umbenennung) für bestehende Lockfiles. Alles andere (auch `design-tokens-clients`, ungescopte Namen) antwortet `404 not_found`, wie ein nicht vorhandenes Paket.

Basis: `https://npm.kette.itdone.de/` (eigener Host, steht in Lockfiles und Projekt-.npmrc, ändert sich nie). Dieselbe Registry antwortet unter `<Lieferdienst>/npm/` für Vorschau und Tests.

Ruhend bis eingerichtet: Solange der Lieferdienst ohne Registry-Adresse oder Upstream-Token läuft, antworten alle Registry-Pfade (auch `/-/ping`) und alle `/registry/*`-Endpunkte `503 { "error": "registry_not_configured", "message": "registry not configured" }`. Solange die Figma-Quelle fehlt, antworten `/figma/links` und `/figma/download/*` `503 { "error": "figma_not_configured", "message": "figma not configured" }`. Die CLI zeigt dann eine Zeile ("npm-Paketzugang folgt mit dem Update bis 30.11.2026" bzw. "Figma-Dateien folgen ..."), `kette login` gelingt trotzdem und schreibt keinen npmrc-Block, `kette init`/`add` schreiben keine Scope-Zeile.

Auth: `Authorization: Bearer kt_...` (so senden npm, pnpm, yarn `_authToken` bzw. `npmAuthToken`). Basic Auth und Tokens im Query-String werden ignoriert. Token-Format `kt_` plus 43 Zeichen base64url.

| Methode und Pfad | Antwort |
|---|---|
| `GET /@getitdone-gmbh%2f<name>`, `GET /@getitdone-gmbh/<name>` | Packument, gefiltert: nur Versionen, die vor `updates_until` der Lizenz erschienen sind; `dist-tags.latest` neu berechnet (Upstream-latest, falls erlaubt, sonst höchste erlaubte Version ohne Vorabkennung); Tarball-URLs auf dieselbe Basis umgeschrieben; ohne `readme`, `maintainers`, `repository`, `gitHead`, `_npmUser`. `Cache-Control: private, max-age=60` |
| `GET /@getitdone-gmbh/<name>/-/<name>-<version>.tgz` | Tarball unverändert (Integrität aus dem Packument gilt). `Cache-Control: private, max-age=31536000, immutable` |
| `GET /-/whoami` | `{ "username": "kette-<erste 8 Zeichen der Lizenz-ID>" }` |
| `GET /-/ping` | `{}`, ohne Token |
| `PUT`, `POST`, `DELETE` | `405 { "error": "read_only" }` |

Fehler (JSON `{ "error": ... }`):
- `401 unauthorized`: Token fehlt, unbekannt, widerrufen oder Gerät freigegeben.
- `403 licence_ended`: Lizenz erstattet oder widerrufen.
- `403 outside_update_window`: Tarball einer Version nach `updates_until`; zusätzlich `message`, `updates_until`, `newest_allowed`, und die Statuszeile nennt Datum und neueste erlaubte Version (npm zeigt sie an).
- `404 not_found`, `429 rate_limited` mit `Retry-After`, `502 upstream_error`, `503 unavailable`, `503 registry_not_configured`.

Limits: 300 Anfragen pro Minute je Token, 60 fehlgeschlagene Anmeldungen pro Minute je Adresse. Ende einer Lizenz oder eines Geräts wirkt nach höchstens 60 Sekunden, Widerruf über die Token-API sofort.

### Token-API (Basis: Lieferdienst, POST mit JSON, Schlüssel nie in URLs)

Alle Aufrufe laufen durch dieselbe Prüfung wie `/install/*` (Fehler `bad_request`, `invalid_key`, `wrong_offer`, `revoked`, `rate_limited`, gemeinsames Limit 10 pro Minute je Schlüssel) und belegen nie ein Gerät.

| Endpunkt | Anfrage | Antwort |
|---|---|---|
| `POST /registry/token` | `{ key, device }` | `200 { token, registry, scope: "@getitdone-gmbh", kind: "device" }`. Das Gerät muss über `/install/token` registriert sein, sonst `409 device_unknown`. Ersetzt das bisherige Token dieses Geräts. `503 registry_not_configured`, solange die Registry nicht eingerichtet ist (gilt für alle `/registry/*`). |
| `POST /registry/token/revoke` | `{ key, device }` | `200 { revoked: true \| false }` (idempotent, `false` wenn keins aktiv war). |
| `POST /registry/ci-tokens/create` | `{ key, device, label }` | `200 { id, token, label, registry, kind: "ci" }`; `label` `[A-Za-z0-9 ._-]{1,48}`, sonst `400 bad_request`; über dem Limit `429 { error: "ci_token_limit", used, max }`. Gerät muss angemeldet sein (`409 device_unknown`). |
| `POST /registry/ci-tokens/list` | `{ key, device }` | `200 { tokens: [{ id, label, prefix, created_at, last_used_at }], max }`, nur aktive, nie der Token selbst. |
| `POST /registry/ci-tokens/revoke` | `{ key, device, id }` | `200 { revoked: true \| false }` (idempotent); `id` keine UUID: `400 bad_request`. |

CI-Tokens: Solo 2, Team (bis 10) 5. Sie belegen kein Gerät.

Speicherung: nur SHA-256 des Tokens mit Lizenz-ID, Geräte-ID (Gerätetoken), Bezeichnung (CI), Präfix (erste 10 Zeichen), Zeitpunkten. Tokens beendeter Lizenzen werden widerrufen, widerrufene Tokens nach 30 Tagen gelöscht. Logs ohne Token, Schlüssel oder `Authorization`.

### Figma

| Endpunkt | Anfrage | Antwort |
|---|---|---|
| `POST /figma/links` | `{ key }` (JSON oder Formular) | `200 { version, updates_until, guide_url, files: [{ name, title, size, sha256, url, expires_at }] }`: neuestes Figma-Release vor `updates_until`. Links 15 Minuten, je Lizenz, Version und Datei. Kein Gerät. Fehler wie `/install/*`, ohne Release im Zeitraum `503 unavailable`, ohne Figma-Quelle `503 figma_not_configured`. |
| `GET /figma/download/:token` | | Datei (`application/octet-stream`, `Content-Disposition: attachment`). `410 expired`, `404 not_found` (auch nach Ende der Lizenz). |
| `GET /figma` | | Formular ohne Skript für alle ohne Terminal. |

Releases im privaten Repo `alexfriedl/kette-figma`, Tag `figma-<YYYY.MM.DD>`, Assets `kette-figma.json` (`{ version, published_at, files: [{ name, title, sha256, size }] }`), je Datei ein Asset (ASCII-Name, `.fig` oder `.md`, bis 50 Dateien) und `IMPORT.md`. `guide_url` ist der Link auf `IMPORT.md`.

### Typen

```ts
type RegistryToken = { token: `kt_${string}`; registry: string; scope: '@getitdone-gmbh'; kind: 'device' };
type CiToken = { id: string; token: `kt_${string}`; label: string; registry: string; kind: 'ci' };
type CiTokenInfo = { id: string; label: string; prefix: string; created_at: string; last_used_at: string | null };
type FigmaLinks = { version: string; updates_until: string; guide_url: string | null; files: { name: string; title: string; size: number; sha256: string; url: string; expires_at: string }[] };
type RegistryError = { error: 'unauthorized' | 'licence_ended' | 'outside_update_window' | 'rate_limited' | 'not_found' | 'read_only' | 'upstream_error' | 'unavailable' | 'registry_not_configured' | 'figma_not_configured' | 'device_unknown' | 'ci_token_limit' | 'bad_request' };
```

## Woher die Pakete kommen
`kette-cli` (`npm run release`) lädt `kette-enterprise-<version>.tgz` plus `kette-enterprise.json` (`{version, sha256, published_at}`) als Asset in ein GitHub-Release des privaten Repos `alexfriedl/kette-engineering` (Tag `v<version>`). chain-delivery liest die Releases mit `GITHUB_TOKEN`, wie heute bei `claude-design-agent-pack`. Nie öffentlich hosten.

## CLI-Verhalten
- `kette login <key>`: Schlüssel nach `~/.kette/credentials` (Rechte 600), Token holen, Paket laden, SHA-256 prüfen, entpacken, Plugins `kette-engineering-core`, `kette-engineering`, `design-system-agents`, und `design-review-pack` installieren, `ui-laws` und das umbenannte `ui-gesetze` aus Community entfernen. Das Agenten-Pack steckt im Enterprise-Paket, der Lieferdienst braucht dafür keinen weiteren Zugriff.
- `kette update`: Community über das Manifest, Enterprise über `/install/latest` und `/install/token`.
- `kette login` danach: `POST /registry/token`, markierter Block in der Benutzer-npmrc (`NPM_CONFIG_USERCONFIG` oder `~/.npmrc`, Rechte 600) mit Scope-Zeile und Token. Eine vorhandene fremde `@getitdone-gmbh:registry`-Zeile bleibt, der Schritt entfällt mit Hinweis; `--npm-replace` kommentiert sie aus, `--no-npm` überspringt. Scheitert der Schritt, bleibt der Login gültig, `kette update` holt ihn nach.
- `kette logout`: `POST /registry/token/revoke` (offline egal), nur den Block entfernen (auskommentierte Zeilen wieder aktiv), dann Schlüssel und Enterprise-Paket lokal entfernen (gibt kein Gerät frei, das macht der Support).
- `kette update`: Block fehlt oder `GET /-/whoami` antwortet 401: neues Token.
- `kette init` und `kette add` (Enterprise): nur `@getitdone-gmbh:registry=<registry>` in die Projekt-`.npmrc`, nie ein Token; eine vorhandene Scope-Zeile bleibt.
- `kette token ci create <label>` / `list` / `revoke <id>`: Token nur einmal anzeigen, CI-Ausschnitt für GitHub Actions und andere.
- `kette figma [--out ordner]`: `POST /figma/links`, alle Dateien laden, SHA-256 prüfen, Import-Reihenfolge zeigen.
- `kette doctor`: Block vorhanden (Hinweis, kein Fehler), Token gültig (ohne `--ci`), Projekt-`.npmrc` zeigt nicht auf npm.pkg.github.com, kein Token in Dateien im Git.
- Fehlertexte auf Deutsch, verständlich, mit nächstem Schritt.
