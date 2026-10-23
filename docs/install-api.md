# Install API (contract between kette-cli and chain-delivery)

As of 2026-10-23. Both sides build against this contract. Change it only together, in kette-cli and chain-delivery at the same time.

## Editions
- **Community (free):** public under `https://kette.itdone.de/dl` (manifest, CLI, bundle `kette-community-<version>.tgz`). No key.
- **Enterprise (Die Kette):** bundle `kette-enterprise-<version>.tgz`, only through this API. Included in every licence tier of Die Kette (Solo and Team), no separate offer.

## Licence key
Format `CDP-XXXXX-XXXXX-XXXXX-XXXXX` (as in chain-delivery). Valid for offers of the family `kette` (kette-solo, kette-team).

## Devices and term
- On the first `kette login` the CLI creates a random device ID (UUID v4) and stores it in `~/.kette/device-id`.
- Limits: Solo 3 devices, Team (up to 10 people) 20 devices. A known device does not count again.
- Updates for 12 months from purchase (`updates_until`). After that the API delivers the newest version published before `updates_until`. Use stays allowed for good.

## Endpoints (base: delivery service, default `https://app-kette-delivery-833790b5.itdone.cloud`, overridable in the CLI with `KETTE_DELIVERY`)

### POST /install/token
Request (JSON): `{ "key": "CDP-…", "device": "<uuid>", "cli": "0.2.0" }`

Responses:
- `200` `{ "edition": "enterprise", "version": "0.20261020.7", "url": "https://…/install/download/<token>", "sha256": "<hex>", "expires_at": "<ISO>", "updates_until": "<ISO>", "seats": { "used": 2, "max": 3 }, "email": "buyer@example.com" }`
  - `url` is a signed link, valid for 15 minutes, for exactly this version.
  - `email` (since CLI 0.6.4) is the licence email. It is only sent after the key passed every check (active licence of the family `kette`), never in an error response. The CLI keeps it in its private state and uses it only to prefill the itdone.cloud registration in `kette cloud setup`; it never logs it otherwise. An older service without the field is fine, the CLI then just does not prefill.
- `400` `{ "error": "bad_request" }` (format of key or device wrong)
- `401` `{ "error": "invalid_key" }` (unknown)
- `403` `{ "error": "revoked" }` (revoked or fully refunded)
- `403` `{ "error": "wrong_offer" }` (key does not belong to the family kette)
- `429` `{ "error": "device_limit", "seats": { "used": 3, "max": 3 } }`
- `503` `{ "error": "unavailable" }` (bundle source not reachable or no matching version available)
- Rate limit against guessing: at most 10 requests per minute per licence key; failed requests (bad_request, invalid_key) also count against at most 60 per minute per reported IP, then `429 { "error": "rate_limited" }`. (The platform only reports node addresses, so the key leads.)

### GET /install/download/:token
Streams the bundle (`application/gzip`). Expired or wrong token: `410` or `404`.

### POST /install/latest
Request (JSON): `{ "key": "CDP-…", "device": "<uuid>" }` (POST so the key does not end up in proxy access logs; GET answers 405).

`200` `{ "version": "…" (newest version overall), "available": "…", "updates_until": "…", "changelog": "…", "email": "…" }`. `email` as for `/install/token` (since CLI 0.6.4), so a login from an older CLI gets it with the next `kette update`. `available` is the newest version this key gets. Registers no new device (only `/install/token` takes devices). Same error codes as above.

## npm registry (design system packages)

Read-only npm proxy in the delivery service for exactly four packages from GitHub Packages: `@getitdone-gmbh/kette-tokens`, `@getitdone-gmbh/kette-design-enterprise`, `@getitdone-gmbh/zero`, `@getitdone-gmbh/zero-pages`. It also serves the old names `@getitdone-gmbh/figma-design-tokens` and `@getitdone-gmbh/component-library-react` for good (read only): the versions from before the rename exist only there, so licences past their update window keep access to their versions. Nothing new is published under the old names from 2027-01-31. Everything else (also `design-tokens-clients`, unscoped names) answers `404 not_found`, like a package that does not exist.

Base: `https://npm.kette.itdone.de/` (own host, written into lockfiles and project .npmrc, never changes). The same registry answers under `<delivery service>/npm/` for previews and tests.

Live since 2026-10-22. `kette login` (CLI 0.6.1 or newer) writes the `@getitdone-gmbh` scope line and a device token into the user npmrc; pipelines use CI tokens from `kette token ci create <name>`. The Figma files are still due by 2026-11-30.

Dormant until configured: while the delivery service runs without a registry address or upstream token, all registry paths (also `/-/ping`) and all `/registry/*` endpoints answer `503 { "error": "registry_not_configured", "message": "registry not configured" }`. While the Figma source is missing, `/figma/links` and `/figma/download/*` answer `503 { "error": "figma_not_configured", "message": "figma not configured" }`. The CLI then shows one line ("npm access is not available right now. Try again later with kette update." or "Figma files are not available right now. Try again later with kette figma."), `kette login` still succeeds and writes no npmrc block, `kette init`/`add` write no scope line.

Auth: `Authorization: Bearer kt_...` (that is how npm, pnpm and yarn send `_authToken` or `npmAuthToken`). Basic auth and tokens in the query string are ignored. Token format `kt_` plus 43 characters base64url.

| Method and path | Response |
|---|---|
| `GET /@getitdone-gmbh%2f<name>`, `GET /@getitdone-gmbh/<name>` | Packument, filtered: only versions published before the licence's `updates_until`; `dist-tags.latest` recalculated (upstream latest if allowed, otherwise the highest allowed version without a prerelease tag); tarball URLs rewritten to the same base; without `readme`, `maintainers`, `repository`, `gitHead`, `_npmUser`. `Cache-Control: private, max-age=60` |
| `GET /@getitdone-gmbh/<name>/-/<name>-<version>.tgz` | Tarball unchanged (integrity from the packument holds). `Cache-Control: private, max-age=31536000, immutable` |
| `GET /-/whoami` | `{ "username": "kette-<first 8 characters of the licence ID>" }` |
| `GET /-/ping` | `{}`, without token |
| `PUT`, `POST`, `DELETE` | `405 { "error": "read_only" }` |

Errors (JSON `{ "error": ... }`):
- `401 unauthorized`: token missing, unknown, revoked or device freed.
- `403 licence_ended`: licence refunded or revoked.
- `403 outside_update_window`: tarball of a version after `updates_until`; also `message`, `updates_until`, `newest_allowed`, and the status line names the date and the newest allowed version (npm shows it).
- `404 not_found`, `429 rate_limited` with `Retry-After`, `502 upstream_error`, `503 unavailable`, `503 registry_not_configured`.

Limits: 300 requests per minute per token, 60 failed sign-ins per minute per address. The end of a licence or device takes effect after at most 60 seconds, revocation through the token API at once.

### Token API (base: delivery service, POST with JSON, keys never in URLs)

All calls go through the same checks as `/install/*` (errors `bad_request`, `invalid_key`, `wrong_offer`, `revoked`, `rate_limited`, shared limit of 10 per minute per key) and never take a device.

| Endpoint | Request | Response |
|---|---|---|
| `POST /registry/token` | `{ key, device }` | `200 { token, registry, scope: "@getitdone-gmbh", kind: "device" }`. The device must be registered through `/install/token`, otherwise `409 device_unknown`. Replaces the previous token of this device. `503 registry_not_configured` while the registry is not set up (applies to all `/registry/*`). |
| `POST /registry/token/revoke` | `{ key, device }` | `200 { revoked: true \| false }` (idempotent, `false` when none was active). |
| `POST /registry/ci-tokens/create` | `{ key, device, label }` | `200 { id, token, label, registry, kind: "ci" }`; `label` `[A-Za-z0-9 ._-]{1,48}`, otherwise `400 bad_request`; over the limit `429 { error: "ci_token_limit", used, max }`. The device must be signed in (`409 device_unknown`). |
| `POST /registry/ci-tokens/list` | `{ key, device }` | `200 { tokens: [{ id, label, prefix, created_at, last_used_at }], max }`, active ones only, never the token itself. |
| `POST /registry/ci-tokens/revoke` | `{ key, device, id }` | `200 { revoked: true \| false }` (idempotent); `id` not a UUID: `400 bad_request`. |

CI tokens: Solo 2, Team (up to 10) 5. They take no device.

Storage: only the SHA-256 of the token with licence ID, device ID (device token), label (CI), prefix (first 10 characters) and timestamps. Tokens of ended licences are revoked, revoked tokens are deleted after 30 days. Logs without token, key or `Authorization`.

### Figma

| Endpoint | Request | Response |
|---|---|---|
| `POST /figma/links` | `{ key }` (JSON or form) | `200 { version, updates_until, guide_url, files: [{ name, title, size, sha256, url, expires_at }] }`: newest Figma release before `updates_until`. Links valid for 15 minutes, per licence, version and file. No device. Errors as for `/install/*`, without a release in the period `503 unavailable`, without a Figma source `503 figma_not_configured`. |
| `GET /figma/download/:token` | | File (`application/octet-stream`, `Content-Disposition: attachment`). `410 expired`, `404 not_found` (also after the licence ended). |
| `GET /figma` | | Form without script for everyone without a terminal. |

Releases in the private repo `alexfriedl/kette-figma`, tag `figma-<YYYY.MM.DD>`, assets `kette-figma.json` (`{ version, published_at, files: [{ name, title, sha256, size }] }`), one asset per file (ASCII name, `.fig` or `.md`, up to 50 files) and `IMPORT.md`. `guide_url` is the link to `IMPORT.md`.

### Types

```ts
type RegistryToken = { token: `kt_${string}`; registry: string; scope: '@getitdone-gmbh'; kind: 'device' };
type CiToken = { id: string; token: `kt_${string}`; label: string; registry: string; kind: 'ci' };
type CiTokenInfo = { id: string; label: string; prefix: string; created_at: string; last_used_at: string | null };
type FigmaLinks = { version: string; updates_until: string; guide_url: string | null; files: { name: string; title: string; size: number; sha256: string; url: string; expires_at: string }[] };
type RegistryError = { error: 'unauthorized' | 'licence_ended' | 'outside_update_window' | 'rate_limited' | 'not_found' | 'read_only' | 'upstream_error' | 'unavailable' | 'registry_not_configured' | 'figma_not_configured' | 'device_unknown' | 'ci_token_limit' | 'bad_request' };
```

## Where the bundles come from
`kette-cli` (`npm run release`) uploads `kette-enterprise-<version>.tgz` plus `kette-enterprise.json` (`{version, sha256, published_at}`) as assets to a GitHub release of the private repo `alexfriedl/kette-engineering` (tag `v<version>`). chain-delivery reads the releases with `GITHUB_TOKEN`, as it does for `claude-design-agent-pack`. Never host them publicly.

## CLI behaviour
- `kette login <key>`: key to `~/.kette/credentials` (mode 600), get a token, download the bundle, verify the SHA-256, unpack, install the plugins `kette-engineering-core`, `kette-engineering`, `design-system-agents` and `design-review-pack`, remove `ui-laws` and the renamed `ui-gesetze` from Community. The agent pack is inside the Enterprise bundle, the delivery service needs no further access for it.
- `kette update`: Community through the manifest, Enterprise through `/install/latest` and `/install/token`. Both store `email` (when present and a valid address) in `~/.kette/state.json` (mode 600) under `login`, `kette logout` removes it.
- `kette cloud setup` with an active Enterprise licence: opens the Keycloak registration with `login_hint=<email>`; Community has no prefill.
- `kette login` afterwards: `POST /registry/token`, marked block in the user npmrc (`NPM_CONFIG_USERCONFIG` or `~/.npmrc`, mode 600) with scope line and token. An existing foreign `@getitdone-gmbh:registry` line stays and the step is skipped with a hint; `--npm-replace` comments it out, `--no-npm` skips the step. If the step fails, the login stays valid and `kette update` catches up.
- `kette logout`: `POST /registry/token/revoke` (offline does not matter), remove only the block (commented-out lines become active again), then remove key and Enterprise bundle locally (frees no device, support does that).
- `kette update`: block missing or `GET /-/whoami` answers 401: new token.
- `kette init` and `kette add` (Enterprise): only `@getitdone-gmbh:registry=<registry>` into the project `.npmrc`, never a token; an existing scope line stays.
- `kette token ci create <label>` / `list` / `revoke <id>`: show the token only once, CI snippet for GitHub Actions and others.
- `kette figma [--out folder]`: `POST /figma/links`, download all files, verify SHA-256, show the import order.
- `kette doctor`: block present (hint, not an error), token valid (without `--ci`), project `.npmrc` does not point to npm.pkg.github.com, no token in files tracked by git.
- Error texts in English, understandable, with the next step.
