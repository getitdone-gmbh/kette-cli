# kette-cli

Sets up the rulebook and the agents of Die Kette from the terminal. Current version: 0.7.1.

```sh
curl -fsSL https://kette.itdone.de/install | sh          # macOS, Linux
irm https://kette.itdone.de/install.ps1 | iex              # Windows
```

Quick start: [Community](docs/setup/community.md) · [Enterprise](docs/setup/enterprise.md) · Website: [kette.itdone.de/en](https://kette.itdone.de/en/)

## Editions
| | Community | Enterprise (Die Kette) |
|---|---|---|
| Core rules and architecture patterns with ADR template | yes | yes |
| Project profile `.kette/profile.json` and `kette doctor` | yes | yes |
| Plugin `kette-engineering-core@kette` (skills `engineering-rules`, `architecture-patterns`, `live-deploy`, agent `kette-check`) | yes | yes |
| Plugin `ui-laws@kette`: UI laws, interaction, WCAG 2.2 AA (skills `ui-laws`, `interaction-principles`, `a11y-standards`) | yes | included in the design review pack |
| Flow in `.kette/README.md` | patterns and ADR, rules while building, review with the agent `kette-check` (per change, or once per release branch), definition of done | roles as subagents, mandatory gates, `/feature-loop` for one feature or as a release train with one review at the end |
| Stack and platform profiles | | yes |
| Templates for CI, Docker and deploy, checks (tsconfig, ESLint, dependency-cruiser, gitleaks) | | yes |
| Plugin `kette-engineering@kette` with the code reviewer | | yes |
| Plugin `design-system-agents@kette`: agents, skills and commands for the whole feature flow | | yes |
| Plugin `design-review-pack@kette`: design reviewer with rulebook | | yes |
| Private npm packages of the design system | | yes |
| Live deploy to itdone.cloud (`kette cloud setup`) | yes | yes |
| Access | free, no key | with a licence key of Die Kette (Solo or Team), `kette login <key>` |
| Updates | any time | 12 months from purchase, the installed version stays usable for good |

The project profile names the edition in the field `tier`: `community` or `enterprise`. The values `free` and `kette` from version 0.1.0 are still read, `kette doctor` points to the new name.

## Commands
| Command | Purpose |
|---|---|
| `kette init [folder]` | New project: profile, agent notes, ADR template, plugins; in Enterprise also CI, Docker and check templates. Ends with a summary: what was created in the project, what is active in Claude Code, next steps |
| `kette add` | Connect an existing repo: detects stack and platform, overwrites nothing except the Kette block in `.kette/README.md`, shows the plan |
| `kette doctor` | Check project and setup: edition, version, updates until, where rulebook and plugins live, and the agents, skills and commands of each plugin; `--ci` for pipelines, without network |
| `kette rules [topic]` | Installed rules without network: overview of core rules and architecture patterns, in Enterprise also stack and platform profiles with status; with a topic it shows that rule, e.g. `kette rules errors`, `kette rules modular-monolith`; `--path` shows the file paths |
| `kette update` | Load the latest rulebook and update the plugins (Community through the manifest, Enterprise through the delivery service); in a project also renew the Kette block in `.kette/README.md` |
| `kette profile` | Show the project profile |
| `kette login [key]` | Unlock Enterprise: check the key, download and verify the bundle, install the plugins, add npm access for the design system packages to `~/.npmrc`. Without a key it reads `KETTE_LICENSE_KEY`, otherwise it asks with hidden input |
| `kette logout` | Remove key, Enterprise bundle and npm access from this machine and revoke the npm token (support frees the device seat) |
| `kette token ci create <name>` / `list` / `revoke <id>` | CI tokens for `npm ci` in pipelines: Solo 2, Team 5, take no device seat, shown only when created |
| `kette figma` | Download the current Figma release of Die Kette, verify checksums, show the import order; `--out folder`. The Figma files follow as an update by 2026-11-30 |
| `kette cloud setup` / `status` | Live deploy to itdone.cloud: account link and the itdone MCP server in Claude Code, see below |
| `kette theme` | Free theme generator: a theme.css for the Community components from your brand colour, light and dark, WCAG AA, see Theming |
| `kette version` | Show the CLI version |

Options: `--dry-run`, `--yes`, `--stack a,b`, `--platform id`, `--patterns a,b`, `--no-plugins`, `--path`, `--no-npm`, `--npm-replace`, `--out folder`, `--have-account`, `--primary`, `--accent`, `--neutral`, `--radius`, `--font`, `--name`, `--preview`, `--json`, `--color` / `--no-color` (default: on in a terminal, off in pipes, CI and with `NO_COLOR`).

## Templates by profile (Enterprise)
CI, Docker and check templates follow the project profile: only the chosen stacks, each in its app folder (`apps` in the profile, otherwise `apps/web`, `apps/api`, `apps/mobile`, `apps/spa`). `kette add` detects app folders such as `backend/`, `frontend/` or `apps/*`. Only Enterprise writes `apps`; a Community project gets the folders from detection when it switches to Enterprise. An existing profile is never rewritten: `kette add` at most raises `tier` and adds `apps` when the field is missing and the installed schema knows it; all other fields stay. Existing files stay unchanged (`= keep`).

Stacks: `nextjs-ts-tailwind`, `nestjs-prisma`, `nestjs-mongoose`, `python-fastapi`, `react-native-expo`, `react-spa` (React and Vite, detected from `vite` plus `react` with an `index.html`, not for Next.js, Expo, React Native, React Router framework, Remix, TanStack Start or a library with React as peer dependency). A detected stack the installed rulebook does not know yet is left out of the profile with a hint to run `kette update`.

If the CLI does not know the template format of the installed rulebook (newer format, unknown placeholders or directives), it writes rules and profile, leaves out templates and checks, and names the command to reinstall the CLI. An older rulebook without templates by profile gives the hint `kette update`.

## npm packages of the design system (Enterprise)
The registry `https://npm.kette.itdone.de/` is live since 2026-10-22 and works with CLI 0.6.1 or newer. It serves `@getitdone-gmbh/kette-tokens`, `@getitdone-gmbh/kette-design-enterprise`, `@getitdone-gmbh/zero` and `@getitdone-gmbh/zero-pages`, plus the old names `@getitdone-gmbh/figma-design-tokens` and `@getitdone-gmbh/component-library-react` for the versions published before the rename (contract: [docs/install-api.md](docs/install-api.md)). The free MIT library `@getitdone-gmbh/kette-design-community` is not part of it.

`kette login` gets its own npm token for this device and writes a marked block into the user npmrc (`NPM_CONFIG_USERCONFIG`, otherwise `~/.npmrc`, mode 600):

```
# >>> kette: managed by kette login, removed by kette logout
@getitdone-gmbh:registry=https://npm.kette.itdone.de/
//npm.kette.itdone.de/:_authToken=kt_...
# <<< kette
```

`kette logout` revokes the token and removes only this block. If the npmrc already has its own `@getitdone-gmbh:registry` line, it stays untouched and the step is skipped; `--npm-replace` comments it out, `kette logout` restores it. In Enterprise projects `kette init` and `kette add` write only the scope line into the project `.npmrc` (no token, safe to commit). `kette update` issues a new token when the block is missing or the registry rejects the token. `kette doctor` checks the block, the token and whether a token sits in a file tracked by git. If the delivery service has no registry set up, `kette login` says "npm access is not available right now. Try again later with kette update." and writes nothing into the npmrc; `kette update` adds the access later, and `kette init` and `kette add` write the scope line only then.

Pipelines get a CI token (`kette token ci create "GitHub Actions"`) as the secret `KETTE_NPM_TOKEN`:

```yaml
- uses: actions/setup-node@v4
  with: { node-version: 22, registry-url: https://npm.kette.itdone.de/, scope: '@getitdone-gmbh' }
- run: npm ci
  env: { NODE_AUTH_TOKEN: ${{ secrets.KETTE_NPM_TOKEN }} }
```

GitLab and others: `npm config set //npm.kette.itdone.de/:_authToken "$KETTE_NPM_TOKEN"` in the job. yarn berry: in `.yarnrc.yml` `npmScopes: { getitdone-gmbh: { npmRegistryServer: "https://npm.kette.itdone.de/", npmAuthToken: "${KETTE_NPM_TOKEN}" } }` (the CLI does not write this).

## Live deploy to itdone.cloud
Available in Community and Enterprise. `kette cloud setup` prepares Claude Code for deploys to [itdone.cloud](https://itdone.cloud):

1. Opens `https://dashboard.itdone.cloud/login?register=1` to create an account. With an active Enterprise licence on the device it adds the licence email (`https://dashboard.itdone.cloud/login?register=1&login_hint=<email>`), the dashboard opens its registration page with the email prefilled. On Windows an address with `+` is printed instead of opened (the opener refuses the encoded `%2B`). Community has no prefill. Without a terminal, in CI, over SSH or when no browser opens, it prints the link. `--have-account` skips this step.
2. Registers the itdone MCP server for all projects, without any auth header. By default with the fixed public OAuth client `kette-cli` (PKCE, loopback redirect on port 53761): `claude mcp add --transport http -s user --client-id kette-cli --callback-port 53761 itdone https://api.itdone.cloud/mcp`. Before that a preflight asks the itdone.cloud Keycloak whether the client exists and accepts the redirect (`GET https://auth.itdone.cloud/realms/itdone/protocol/openid-connect/auth?client_id=kette-cli&response_type=code&redirect_uri=http://localhost:53761/callback&code_challenge=…&code_challenge_method=S256`, the login page means yes). If it does not, or the server does not answer within 5 seconds, setup says so in one line and registers with dynamic client registration (DCR) as before: `claude mcp add --transport http -s user itdone https://api.itdone.cloud/mcp`. `--dcr` always uses DCR and skips the preflight. An existing `itdone` entry is never overwritten, the command shows its URL and sign-in method and continues. If the entry uses DCR and the fixed client is available, it says how to switch: `claude mcp remove itdone -s user`, then `kette cloud setup`.
3. Shows the next steps: in Claude Code run `/mcp`, choose `itdone`, then `Authenticate`. Claude Code signs in through the browser (OAuth), the account is created on the first login. Then ask Claude to deploy; the `live-deploy` skill deploys only after you confirm.

`--dry-run` shows the steps without opening the browser or calling `claude mcp add` (the preflight still runs, it only reads). `kette cloud status` shows whether the server is registered and whether it signs in through the fixed client or DCR (exit code 0 either way), and `kette doctor` names the same as an info line. kette never asks for, stores or prints a password or token. Without Claude Code, `kette cloud setup` stops with exit code 1.

| Environment variable | Default | Purpose |
|---|---|---|
| `KETTE_CLOUD_CLIENT_ID` | `kette-cli` | OAuth client ID for `--client-id` (letters, digits, `.`, `_`, `-`, up to 64) |
| `KETTE_CLOUD_CALLBACK_PORT` | `53761` | Loopback port for `--callback-port` (1024 to 65535) |
| `KETTE_CLOUD_AUTH_URL` | `https://auth.itdone.cloud/realms/itdone` | Keycloak realm for the preflight (https, plain http only for localhost or with `KETTE_INSECURE=1`) |

The licence email comes from the delivery service (`/install/token` on `kette login`, `/install/latest` on `kette update`) and is kept in `~/.kette/state.json` (mode 600) next to the other licence fields. It is only shown in the setup line that opens or prints the link; `kette state` shows `(stored)` instead, `kette logout` removes it. A login made before CLI 0.6.4 gets it with the next `kette update`.

## Theming
`kette theme` generates a complete theme for the free Community components (`@getitdone-gmbh/kette-design-community`) from your brand colour. The result is a drop-in replacement for the Community theme file:

```css
/* before */
@import '@getitdone-gmbh/kette-design-community/theme.css';
/* after */
@import './theme.css';
```

```sh
kette theme                                    # questions in a terminal
kette theme --primary "#0f766e"                # flags, e.g. in scripts and CI
kette theme --primary "#4f46e5" --accent "#db2777" --neutral warm --radius lg --font "IBM Plex Sans" --name acme --out src/styles/theme.css --preview
kette theme --primary "#c2410c" --json --dry-run   # tokens and contrast report as JSON, nothing written
```

| Option | Values | Default |
|---|---|---|
| `--primary` | hex colour, required without a terminal | |
| `--accent` | hex colour for accent surfaces (accent, sidebar accent) | neutral |
| `--neutral` | `cool` (the slate of the Community theme), `warm`, `neutral` (pure grey) or a hex colour that tints the greys | `cool` |
| `--radius` | `none`, `sm`, `md`, `lg`, `full` (pill controls, doubled surfaces) or pixels up to 64 | `md` (8px) |
| `--font` | font family or stack; the theme names it, load the font yourself | Inter |
| `--name` | lowercase letters, digits, dashes | `custom-<primary>` |
| `--out` | CSS file or folder | `./theme.css` |
| `--preview` | also writes `theme-preview.html` next to it (self-contained: components in light and dark, palettes, contrast table) and opens it in a terminal | off |
| `--dry-run` | writes nothing | off |
| `--json` | prints the tokens, palettes, every contrast check and every adjustment as JSON | off |

What it generates, in one run, for light and dark:
- Exactly the variable set of the Community `theme.css` per block (0.4.3: 1401 variables, same selectors: `:root`, `.dark`, the dark `prefers-color-scheme` block, the paper scope `.light, [data-document-surface], [data-surface="paper"]`, product blocks, typography classes). Sizes, spacing, motion and typography stay as they are.
- Tonal palettes in OKLCH: the brand ramp of the Community theme is moved onto your primary (lightness through your colour, gamut-relative chroma, hue offsets kept), so your exact primary is the fill of primary buttons. Neutrals follow `--neutral`, chart series rotate with the primary hue, status colours (destructive, success, warning, info) and data colours keep their meaning.
- Radius scale, font family and elevation (shadow colours follow the neutral family).
- WCAG 2.2 AA for every fill/text pair: the 51 pairs of `color-pairs.js` from kette-tokens (status pairs included), the status and badge pairs the Community package tests, text on the paper surface, page, card, canvas and input (4.5:1) and focus rings (3:1), 94 checks. A pair below its minimum gets the smallest lightness change of its text (or of its fill when the text is shared), and every change is reported. A failing pair is never emitted; the command stops instead.
- The pair rules of the Community package: no block sets one side of a pair without the other, every pair variable (accent and destructive included) is declared in `:root`, both dark blocks and paper, paper resolves to the light values (also inside a dark page), the dark media block equals `.dark`. A dark contrast fix on a variable the dark blocks inherit is pinned there, and with its light value in paper.

The same inputs always give the same file. No network, no dependencies.

If you use the prebuilt `@getitdone-gmbh/kette-design-community/styles.css` instead of Tailwind, import your `theme.css` after it.

**Community version.** Use Community 0.4.3 or newer: its `theme.css` is self-contained, and the generated file carries its variable set (light values for 58 colour roles such as `--colors-avatar-*`, `--colors-switch-*` and `--colors-error`, the typography role `--typo-button-*` with `.typography-button`). With 0.4.2 the generated file works too: the extra variables are harmless, and they give the light `border-error`, `ring-error` and `bg-background-accent` the colour 0.4.2 left undefined. The Tailwind colours that use the other new variables (for example `bg-avatar-background-default`) exist only in the 0.4.3 preset.

**Community and Enterprise.** Community generates a theme.css on top of the token system: one brand, light and dark. Enterprise extends the token source itself in `@getitdone-gmbh/kette-tokens`: several brands, component tokens and Figma variables synced to code (`kette login`).

**After a Community or tokens update.** All data sits in one file, `src/theme/manifest.json`, built from a copy of the Community `theme.css` and of `scripts/color-pairs.js` from kette-tokens in `test/fixtures` (now Community 0.4.3 at `639d509` and kette-tokens `v5.23.2`). Replace both fixtures (keep the first line that names the source), update the source labels in `scripts/theme-manifest.mjs`, run `node scripts/theme-manifest.mjs` and `npm test`. The tests fail when the manifest is not the build of the fixtures, when a block of the generated CSS differs from the Community block, or when a pair rule or contrast check fails. With the base blue and cool neutrals the generator reproduces the Community values exactly, with no adjustment.

## Where the rules live
The project holds only a few files: `.kette/profile.json`, `.kette/README.md`, the reference line in `CLAUDE.md` and the ADR template. The rulebook itself lives on the machine under `~/.kette/bundles/active/` and is active in Claude Code as plugins: in Community `kette-engineering-core@kette` and `ui-laws@kette`, in Enterprise `kette-engineering-core@kette`, `kette-engineering@kette` (`platform-profile`, `code-reviewer`), `design-system-agents@kette` and `design-review-pack@kette`. Browse with `kette rules`; `kette doctor` shows what each plugin brings.

`.kette/README.md` describes the flow for Claude Code between `<!-- kette:begin` and `<!-- kette:end -->`. `kette init`, `kette add` and `kette update` renew only this block; your own notes below it stay, and so do line endings (LF or CRLF). If a marker is missing or appears twice, the file stays unchanged. An unchanged version from 0.1.0 to 0.3.1 without a block is replaced completely, an edited one stays, and the CLI says how to recreate it.

The flow follows `tier` in the project profile, not the machine ([ADR-0001](docs/adr/0001-flow-follows-profile.md)). `kette add` raises `tier` to the edition of the machine but never lowers it. If the machine has a lower edition than the project, `kette doctor` warns.

When the edition changes, the CLI removes the plugins the new edition does not have: `kette login` removes `ui-laws@kette` (its skills ship in the design review pack), `kette logout` removes the three Enterprise plugins before it switches to the Community bundle and installs `ui-laws@kette` again. The renamed `ui-gesetze@kette` is removed by `kette update` and `kette add` once the bundle has `ui-laws`, and always by `kette login` before the marketplace points to the new bundle. This needs CLI 0.6.2 or newer. The CLI checks the plugin list to see whether a plugin is gone. If an older bundle on the machine does not contain a plugin yet, it installs the others and names `kette update`. If the agent pack is also installed separately (marketplace `claude-design-agent-pack`), it stays untouched and the CLI names the duplicate plugins.

Rule topics are English. The German topic names of older rulebooks (`kette rules lesbarkeit`) still work through `rules/aliases.json` with CLI 0.6.2 or newer.

The marketplace of the delivered bundles is called `kette` in Claude Code. Up to version 0.3.0 it was called `kette-engineering`. If an old `kette-engineering` points into `~/.kette`, the CLI replaces it on the next `kette init`, `add`, `update` or `login`. If it points to a working copy of the rulebook, it stays, and the CLI names the command to disable it in case skills are active twice.

## What the installer does
- Checks for Node.js 20 or newer, git and tar.
- Downloads `manifest.json` and the CLI from the mirror and verifies the SHA-256 from the manifest. If it does not match, it stops.
- Unpacks the CLI to `~/.kette/cli/<version>` and creates `~/.kette/bin/kette`.
- Extends the PATH: `install.sh` appends `export PATH="$HOME/.kette/bin:$PATH"` to `~/.zshrc` (zsh), `~/.bashrc` (bash) or otherwise `~/.profile`, only when the line is missing, and shows what it changed. `install.ps1` extends the user PATH.

## What the installer does not do
- No sudo, no changes outside `~/.kette` and the one line in the shell startup file.
- No cloud actions, no deploy, no accounts. Infrastructure is written as code in the repo.
- No overwriting of existing files. `CLAUDE.md` gets at most a reference line, the project `.npmrc` at most the scope line, the user npmrc only the marked Kette block.
- No telemetry. The delivery service sees only key, device ID, CLI version and IP address, and only on `kette login`, `kette update`, `kette token` and `kette figma` in Enterprise.

## Uninstall
1. If logged in: `kette logout` (also removes the npm block from `~/.npmrc`). Only support frees the device seat of the licence.
2. Remove plugins and marketplace from Claude Code:
   ```sh
   claude plugin uninstall design-review-pack@kette
   claude plugin uninstall design-system-agents@kette
   claude plugin uninstall kette-engineering@kette
   claude plugin uninstall ui-laws@kette
   claude plugin uninstall kette-engineering-core@kette
   claude plugin marketplace remove kette
   ```
3. Delete the store: `rm -rf ~/.kette` (or the folder from `KETTE_HOME`).
4. In the shell startup file (`~/.zshrc`, `~/.bashrc` or `~/.profile`) delete the line `# kette` and the PATH line below it. Windows: remove `~\.kette\bin` from the user PATH.

The files in the project (`.kette/`, reference line in `CLAUDE.md`, ADR template) stay until someone deletes them.

## Environment variables
| Variable | Default | Purpose |
|---|---|---|
| `KETTE_HOME` | `~/.kette` | Store for CLI, bundles, key (`credentials`, mode 600) and device ID |
| `KETTE_MIRROR` | `https://kette.itdone.de/dl` | Mirror for manifest, CLI and Community bundle, e.g. for companies and offline environments |
| `KETTE_DELIVERY` | `https://app-kette-delivery-833790b5.itdone.cloud` | Delivery service for Enterprise (contract: [docs/install-api.md](docs/install-api.md)) |
| `KETTE_REGISTRY` | `https://npm.kette.itdone.de/` | Registry for the scope line until a login takes the address from the delivery service |
| `KETTE_LICENSE_KEY` | not set | Licence key for `kette login` without an argument, so it stays out of the shell history |
| `NPM_CONFIG_USERCONFIG` | `~/.npmrc` | User npmrc that `kette login` writes the block into (like npm) |
| `KETTE_NO_MODIFY_PATH` | not set | `1` leaves the shell startup file unchanged, the installer then shows the line to add yourself |
| `KETTE_INSECURE` | not set | `1` allows plain http for mirror, delivery service and registry, only for a trusted test server (localhost is always allowed) |
| `KETTE_THEME` | not set | `dark` or `light` for the terminal colors, otherwise taken from `COLORFGBG` |
| `NO_COLOR` | not set | Turns colors off unless `--color` is given |

## Release
`npm run release` builds locally into `dist/`, without publishing anything, from `../kette-engineering` (or `KETTE_ENGINEERING`) and the plugins `ui-laws`, `design-system-agents`, `design-review-pack` from `../claude-design-agent-pack` (or `KETTE_AGENT_PACK`). From the agent pack it takes the state of the newest tag `vX.Y.Z` in git, not the working folder; `KETTE_AGENT_PACK_REF` picks another state for testing. kette-engineering must have no uncommitted changes (`KETTE_ALLOW_DIRTY=1` only for local tests). The version is `0.<date>.<commits of kette-engineering plus commits of the agent pack>`, and the bundles are reproducible: the same content gives the same checksum on the same build system (macOS tar and GNU tar can differ, so a release always builds on one system). Which agent pack plugins go into which bundle is read from `src/editions.mjs`. If the chosen state lacks one of them (tag `v1.2.2` still has `ui-gesetze` instead of `ui-laws`), the script stops with the plugin lists and builds nothing. If `dist/` already holds the same bundle version or the same CLI version with different content, the script stops and leaves `dist/` unchanged.
- `install.sh`, `install.ps1`, `manifest.json`, `kette-cli-<version>.tgz`, `kette-community-<version>.tgz` (public under `https://kette.itdone.de/dl/`)
- Community bundle: `kette-engineering-core`, `ui-laws`
- `private/kette-enterprise-<version>.tgz` with `kette-engineering-core`, `kette-engineering`, `design-system-agents`, `design-review-pack`, and `private/kette-enterprise.json` (`{version, sha256, published_at, agent_pack}`), never public

`npm run release -- --publish-enterprise` also uploads the Enterprise bundle with `gh release create` as release `v<version>` to the private repo `alexfriedl/kette-engineering`, where the delivery service picks it up. The script stops when the repo is not private, kette-engineering has uncommitted changes, the commit is not pushed, or the agent pack state is not a release tag. Without the switch it only prints the command.

A new CLI version: raise `version` in `package.json`, add an entry to [CHANGELOG.md](CHANGELOG.md), run `npm test`, then `npm run release`.

## Tests
`npm test` runs the whole suite (Node 20 or newer). CI runs it on Linux, macOS and Windows with Node 20 and 22, runs `install.ps1` against a local mirror on Windows, and lints `install.sh` with `sh -n` and shellcheck.

## Licence
MIT, see [LICENSE](LICENSE). The Enterprise content of Die Kette is under its own licence inside the bundle.
