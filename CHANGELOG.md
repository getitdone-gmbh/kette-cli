# Changelog

## 0.7.0
- New `kette theme` (Community and Enterprise, free): generates a theme.css for `@getitdone-gmbh/kette-design-community` from a brand colour, a drop-in replacement for `@import '@getitdone-gmbh/kette-design-community/theme.css'`. Questions in a terminal, otherwise `--primary <hex>` (required) with `--accent`, `--neutral warm|cool|neutral|<hex>`, `--radius none|sm|md|lg|full|<px>`, `--font`, `--name`, `--out` (default `./theme.css`), `--preview` (self-contained `theme-preview.html` with components in light and dark, palettes and contrast table), `--dry-run` and `--json`. Without a terminal and without `--primary` it stops with exit code 2. A file it did not write is only replaced after a yes or with `--yes`.
- Light and dark in one file with exactly the 1334 variables and selectors of Community 0.4.1: OKLCH tonal palettes from the primary, neutral family, accent surfaces, chart series, radius scale, font, elevation. Status and data colours keep their meaning.
- WCAG 2.2 AA enforced: the 27 fill/text pairs of `color-pairs.js` (kette-tokens 5.22.1) plus text, status and focus pairs, 72 checks per mode. Values below 4.5:1 (3:1 for focus rings) get the smallest lightness change, each change is reported, a failing pair is never written. Both sides of every pair are pinned in `:root`, `.dark`, the dark media block and the paper scope.
- Deterministic and without dependencies; all data in `src/theme/manifest.json`, rebuilt with `node scripts/theme-manifest.mjs` from the fixtures in `test/fixtures` (README "Theming").
- Output notes the editions: Community generates the theme.css, Enterprise extends the token source in kette-tokens (several brands, Figma variables).

## 0.6.5
- Enterprise: `kette cloud setup` opens the registration through the dashboard (`https://dashboard.itdone.cloud/login?register=1&login_hint=<email>`) instead of the Keycloak registrations URL. The dashboard passes the licence email on to the registration form and keeps its own login state, so the account creation now ends signed in on the dashboard instead of at `/callback` without a matching state. Encoding is unchanged: `@` stays readable, `+` becomes `%2B` (on Windows such a link is printed instead of opened). `KETTE_CLOUD_AUTH_URL` now only affects the preflight.

## 0.6.4
- `kette cloud setup` registers the itdone MCP server with the fixed public OAuth client `kette-cli` (PKCE, loopback redirect on port 53761): `claude mcp add --transport http -s user --client-id kette-cli --callback-port 53761 itdone https://api.itdone.cloud/mcp`, so Claude Code no longer registers a new client on every login. A preflight asks the itdone.cloud Keycloak first whether the client exists and accepts the redirect; until it does (or when the server does not answer within 5 seconds) setup says so in one line and falls back to dynamic client registration (DCR) as before.
- New `--dcr` for `kette cloud setup`: always DCR, no preflight. `KETTE_CLOUD_CLIENT_ID` and `KETTE_CLOUD_CALLBACK_PORT` override client ID and port, `KETTE_CLOUD_AUTH_URL` the Keycloak realm; wrong values stop with exit code 2 before anything changes.
- An existing `itdone` entry is still never overwritten. If it uses DCR and the fixed client is available, setup says how to switch: `claude mcp remove itdone -s user`, then `kette cloud setup`.
- `kette cloud status` and `kette doctor` show whether the itdone MCP server signs in through the fixed client (with its callback port) or DCR.
- Enterprise: `kette cloud setup` opens the itdone.cloud registration with the licence email prefilled (Keycloak registration page with `login_hint`). The delivery service sends the email with `/install/token` and `/install/latest` (contract in `docs/install-api.md`), the CLI keeps it in `~/.kette/state.json` (mode 600), shows it only in the setup line, `kette state` prints `(stored)`, `kette logout` removes it. A login made with an older CLI gets it with the next `kette update`. Community has no prefill.

## 0.6.3
- New `kette cloud setup` (Community and Enterprise): opens the itdone.cloud registration (`--have-account` skips it, headless prints the link), registers the itdone MCP server in Claude Code with `claude mcp add --transport http -s user itdone https://api.itdone.cloud/mcp` without any auth header, and shows the next steps (`/mcp`, itdone, Authenticate; deploy only after confirming). An existing `itdone` entry is never overwritten. `--dry-run` changes nothing. kette never handles a password or token.
- New `kette cloud status`: shows whether the itdone MCP server is registered, exit code 0 either way.
- `kette doctor` adds an info line: `itdone MCP registered` or `Live deploy: kette cloud setup`, never counted as a problem.

## 0.6.2
- The agent pack plugin `ui-gesetze` is now `ui-laws` (skills `ui-laws`, `interaction-principles`, `a11y-standards`). Community installs `ui-laws@kette`, and `kette update` and `kette add` remove `ui-gesetze@kette` once the bundle has `ui-laws`. Enterprise does not install it (the skills ship in `design-review-pack` and `design-system-agents`): `kette login` removes `ui-laws@kette` and `ui-gesetze@kette`, `kette logout` installs `ui-laws@kette` again, or `ui-gesetze@kette` when the local Community bundle is older.
- `kette rules` finds the German topic names of older rulebooks (`kette rules lesbarkeit`) through `rules/aliases.json`, and a typo of an old name suggests the new topic.
- New stack `react-spa` (React + Vite single page app, Enterprise, app folder `apps/spa`): in the stack question, `--stack react-spa`, and detected from `vite` plus `react` with an `index.html`, but not for Next.js, Expo, React Native, React Router framework, Remix, TanStack Start or a library with React as peer dependency. Platform templates skip it with a hint. A detected stack the installed rulebook does not know yet is left out of the profile with a hint to run `kette update`.
- Community: `kette rules <profile>` for any stack or platform profile the rulebook names (e.g. `react-spa`) says it is an Enterprise profile and points to `kette login`. The Community bundle now carries `profiles/stack/index.json` for that.
- `.kette/README.md` names the core topic `comments` too.
- `kette update` on Node 23 no longer stops with "Path is a directory" when it moves the active bundle link.
- Arguments named like `toString` or `constructor` are read as plain arguments: `kette rules toString` reports an unknown topic.
- Update the CLI before or with this rulebook. CLI 0.6.1 and older do not know `ui-laws`, keep `ui-gesetze@kette` and warn that the bundle lacks it. If that already happened, `kette update` with CLI 0.6.2 repairs the plugins even when the bundle is up to date, and `kette doctor` names that step.
- German rule topic names (`kette rules lesbarkeit`) need CLI 0.6.2 or newer.
- CLI 0.5.x: update the CLI to see the `preview` platform warning again.
