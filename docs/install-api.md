# Install-API (Vertrag zwischen kette-cli und chain-delivery)

Stand 2026-10-20. Beide Seiten bauen gegen diesen Vertrag. Änderungen nur gemeinsam.

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

## Woher die Pakete kommen
`kette-cli` (`npm run release`) lädt `kette-enterprise-<version>.tgz` plus `kette-enterprise.json` (`{version, sha256, published_at}`) als Asset in ein GitHub-Release des privaten Repos `alexfriedl/kette-engineering` (Tag `v<version>`). chain-delivery liest die Releases mit `GITHUB_TOKEN`, wie heute bei `claude-design-agent-pack`. Nie öffentlich hosten.

## CLI-Verhalten
- `kette login <key>`: Schlüssel nach `~/.kette/credentials` (Rechte 600), Token holen, Paket laden, SHA-256 prüfen, entpacken, Plugins `kette-engineering-core`, `kette-engineering`, `design-system-agents` und `design-review-pack` installieren, `ui-gesetze` aus Community entfernen. Das Agenten-Pack steckt im Enterprise-Paket, der Lieferdienst braucht dafür keinen weiteren Zugriff.
- `kette update`: Community über das Manifest, Enterprise über `/install/latest` und `/install/token`.
- `kette logout`: Schlüssel und Enterprise-Paket lokal entfernen (gibt kein Gerät frei, das macht der Support).
- Fehlertexte auf Deutsch, verständlich, mit nächstem Schritt.
