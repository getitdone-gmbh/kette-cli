# Changelog

## Unreleased
- Ticketing (Enterprise, KD-0034, ADR-0003): `kette ticket connect | new | list | show | edit | extend | route | pick | link | check | close | inbox | report | why`. Board, stations, members and definitions of done come from the repo's instance, the credential `KETTE_TICKETING_WORKBASE_TOKEN` from the project wallet (or the shared Workbase session file), never printed. Writes are planned on a copy of the board, shown, and sent only after a yes or `--yes`; `--dry-run` everywhere. `kette ticket check <KD>` shows the follow-through per station (KETTE-24). The library ships in the Enterprise bundle, never in this package; Community and a bundle without it get a clear message.
- `kette init` and `kette add` offer to connect a board in a terminal, after the wallet step.
- `kette ticket hook install | status | remove`: the intake hook in the project's `.claude/settings.json`, never the user settings; remove takes only kette's entry.
- Instance stations may be objects with `definitionOfDone`, `owner`, `builder`, `approve`, `merge` and `targets`; the routing in the bundle is neutral (KETTE-27).
- `kette ticket repair <KD>` completes a decision an interrupted run left half; `list` and `report` name it (KETTE-31). Parallel `kette ticket new` of one instance never share an id (KETTE-29).
- Approvals and acting as a person of the instance only from that person at a terminal; project ids are one path segment; the shared session file only with `ticketing.session: true`; ticketing code only from inside `~/.kette/bundles` (KETTE-28).
- The intake hook asks no model unless `ticketing.intakeModel` names one and this machine confirmed its host (`kette ticket hook trust`, KETTE-26, KETTE-32); private, link-local and unique-local addresses are refused, also behind a host name (KETTE-38). Two machines that record the same id at the same moment end with two ids, the later one renumbers itself (KETTE-29). The Enterprise plugin `kette-ticketing` brings the agent `kette-intake` and `/intake` (KETTE-30).

## 0.10.0
- Kette instances (Workbase ZERO-538, ADR-0002): `kette instance create <name> [--edition enterprise|community] [--from <git-url|folder>] | list | show | use | add-repo | members | remove`. Each instance has its own scope in `~/.kette/instances/<name>/instance.json`: edition, bundle pin, repos, members, ticketing, wallet defaults, overlays, chain stations; it can live in its own git repo. One licence covers all instances, seats stay per device.
- `.kette/profile.json` names the instance (`instance`); the repo inherits edition, ticketing, wallet defaults, overlays and stations, its own values win. `kette init` and `kette add` take `--instance <name>` and ask in a terminal; `kette profile --effective` shows the inherited values and `.kette/README.md` tells agents to read them; `kette doctor --instance [name]` checks every checkout of an instance.
- Editions mix on one machine: a Community instance never enables Enterprise plugins, templates, the registry line or the wallet, even with a licence; an Enterprise instance needs the licence and says so clearly. A profile that names a missing or damaged instance counts as Community for every check; `kette login` and `kette update` warn about it and finish.
- Plugins are enabled per project, never in the user scope, from one marketplace per edition: `<plugin>@kette-community` from the Community bundle, `<plugin>@kette-enterprise` from the Enterprise bundle (`~/.kette/bundles/marketplace-<edition>`). `.claude/settings.json` switches the edition plugins on and every other Kette ID off, also the legacy `<plugin>@kette`; the marketplace path goes into `.claude/settings.local.json` (git ignored). `kette rules`, `.kette/README.md` and `kette doctor` in a Community repo point only to the Community bundle. Plugins from older versions in the user scope stay, `kette doctor` names them, `kette logout` removes the Enterprise ones and the marketplace `kette-enterprise`.
- Joining a Community instance removes the Enterprise files kette wrote (registry scope line, template files recorded with their hash in `.kette/templates.json`); changed files stay and `kette doctor` names them.
- Repo identity by normalised origin (tokens never stored or printed, ssh and https forms equal) or git common folder; a repo belongs to one instance; worktrees and same-named repos without origin are tracked. Every check that can stop a join runs before a project file is written.
- Locks for `state.json`, `instance.json`, marketplace builds and bundle unpacking (a lock file linked into place with its owner, removed only by the claimant of its token), so parallel kette processes stay consistent, also when one is killed; atomic writes everywhere. A registration under another `~/.kette` folder is repointed, never removed, so installed plugins stay.
- `--from` clones only over https, ssh and local paths, without prompts or stdin; URLs and member ids are printed without user info and control characters; names Windows reserves are refused.
- Every file kette writes into a project is written atomically (temp file, flush, rename; a new file is hard-linked): a kette killed while writing never leaves an empty `.kette/profile.json` or a half `.claude/settings.json`. Temp files of a killed run are removed by the next write and ignored by git (pattern in the `.gitignore` kette keeps). On drives without hard links (exFAT, FAT, some network drives) new files are created with an exclusive open instead, never replacing a file. New files get their mode from the umask as before.
- **Breaking:** npm: only the token is global (`~/.npmrc`, kette block); the `@getitdone-gmbh` scope line lives in the project `.npmrc` of Enterprise projects, so npm in a Community repo never uses the Enterprise registry. A block from before 0.10 keeps its line until you agree: `kette update` and `kette login` ask in a terminal, otherwise they name the new `kette npm move-scope`. After the move, other apps that install `@getitdone-gmbh` packages need the line in their own `.npmrc`. `kette doctor` names an Enterprise project without the line and a Community instance repo where the global line still resolves the Enterprise registry.
- Leaving Enterprise removes only the exact scope line kette wrote and keeps foreign registry lines and line endings; a repo without an instance is never changed this way. `kette instance use` with an Enterprise instance adds the scope line, `kette doctor` names missing Enterprise templates (`kette add`).
- `claude plugin marketplace remove` runs from `~/.kette`, so `kette logout` inside a repo never changes its committed `.claude/settings.json`.
- The whole team needs kette 0.10 or newer: committed settings switch the `<plugin>@kette` IDs of older versions off.
- New sandbox tests: every command of the help with HOME, `~/.kette`, `~/.npmrc` and the Claude Code config in temp folders against fake servers, with a file system diff after each command, plus regression scenarios for every finding of the review and QA; they run on Linux, macOS and Windows. Test matrix in docs/instances.md.

## 0.9.4
- The release train is now called batch review. The flow text in `.kette/README.md` (written by `kette add` and `kette update`) says "batch review" and starts it by describing the round to `/feature-loop` (for example `/feature-loop filter and export done, review at the end`) instead of naming branches. `flow.mode: batch` is the new value, the old value `train` gives the same text.
- `kette init` and `kette add` (Enterprise) name `/feature-loop <description of the round>` in the next steps.
- Goes with claude-design-agent-pack 1.7.0 and kette-engineering 0.6.0.

## 0.9.3
- Hidden prompts (`kette login`, `kette wallet set`) accept pasted values: bracketed-paste markers and other control characters are removed (iTerm sent them with the key, so a pasted licence key was refused).
- Without a terminal the hidden prompts say how to pass the value instead (`kette login <key>` or `KETTE_LICENSE_KEY`, `kette wallet set … --stdin`), not the init hint about `--yes`.

## 0.9.2
- `kette wallet help` and the end of `kette wallet init` say who owns the credentials: your own Infisical or vault; Get IT Done never sees or stores a value and does not manage credentials. Same in the README.

## 0.9.1
- Review flow per project: optional `flow` in `.kette/profile.json` (`mode` `train` or `per-change`, `maxParallel`, `fixRounds`, reviewers in `review.ui` and `review.code`). `kette add` and `kette update` write it into `.kette/README.md`: with `mode: train` the release train is the project default (no review per branch or pull request), with `per-change` the gates run on every change, and the named reviewers replace the default gate list. Without `flow` the text stays as before.
- `kette doctor` warns when the profile sets `flow` and the installed rulebook does not know it yet (`kette update`), and when a Community project names Enterprise reviewers.
- The profile check knows whole numbers with limits (copy of `kette-engineering/lib/validate.mjs`).
- Needs kette-engineering with the `flow` schema; goes with claude-design-agent-pack 1.6.0 (`/feature-loop` reads `flow`).
## 0.9.0
- Secret wallet in the onboarding: `kette init` and `kette add` (Enterprise, in a terminal) offer `kette wallet init` at the end and list it in the next steps while the project has no wallet; `kette doctor` shows it as INFO.
- `kette wallet init` guides Infisical: checks the Infisical CLI (install hint otherwise), region EU, US or own instance, starts `infisical login` when not signed in, picks the project with `infisical init` or takes `.infisical.json`, then reaches every environment once and says which one is missing. `--yes` also takes the project from `.infisical.json`.
- Provider choice marks Vault, AWS Secrets Manager and Azure Key Vault as preview (tested with stand-ins only); Infisical is the verified default.
- New `kette wallet import <file> --env <env>`: moves the values of a `.env` file into the wallet, declares new names, prints names only, warns when the file is tracked by git, offers to delete it. `--dry-run` shows the plan.

## 0.8.0
- New secret wallet for Enterprise (Die Kette): `kette wallet init | status | add | set | remove | run | sync github | trust`. `.kette/wallet.json` in the repo holds provider, environments and names (per app, with a note), never a value. Values stay in the provider: Infisical by default (cloud or self-hosted), or Vault/OpenBao (KV v2), AWS Secrets Manager, Azure Key Vault, or your own commands (`command`, e.g. 1Password, Doppler, pass).
- Values never travel as an argument: Infisical through a private temp YAML file, Vault and `gh` through stdin, AWS and Azure through a private temp file, removed right away. Output shows names only.
- `kette wallet run --env <env> -- <command>` passes exactly the declared secrets (of one app with `--app`) and stops before the start when one is missing. `kette wallet sync github` copies them into a GitHub environment after a yes.
- Every machine confirms the provider block once (`kette wallet trust`, CI: `KETTE_WALLET_TRUST=1`), so a cloned repo cannot run commands or point to another server unasked.
- `kette wallet init` reads names from `.env.example` files and sets `platform.secrets` in the profile. `kette doctor` shows the wallet and whether this machine confirmed it.
- `--` ends the kette options, everything after it belongs to the command of `kette wallet run`.

## 0.7.2
- Flow text in `.kette/README.md` (rewritten by `kette update` and `kette add`) describes two modes. Enterprise: one feature with `/feature-loop start`, or a release train with `/feature-loop train <name> <branch...>`: builders self-check against the rules and the probes in `.review/probes/`, all branches merge onto one release branch, the gates run once there in parallel, one fix round, then a re-check of only the failed findings, at most 4 heavy agents at once. The UI gate now names `design-review-pack:ux-reviewer` next to `design-reviewer`. Community: several branches get one `kette-check` on the release branch and a re-check of the open findings.
- Definition of done for several branches: the review on the integrated release branch passes.
- `kette init` and `kette add` (Enterprise) name `/feature-loop train` in the next steps.
- Goes with claude-design-agent-pack 1.5.0 (release train in `/feature-loop`, re-check mode and probes for `design-reviewer` and `ux-reviewer`) and kette-engineering-core 0.4.0 (`kette-check` per release branch and as a targeted re-check).

## 0.7.1
- Theme generator follows Community 0.4.3: standalone-complete theme, new typography button variables, accent/destructive pairs in all scopes.
- The generated file carries the 0.4.3 variable set per block (1401 variables: `:root` 1401, `.dark` and the dark media block 487 each, paper 487): light values for the 58 colour roles Community 0.4.2 left undefined in light mode, `--typo-button-*` with `.typography-button`, and `--colors-background-accent`, `--colors-background-destructive`, `--colors-foreground-accent`, `--colors-foreground-destructive` in `:root`, both dark blocks and paper.
- Every pair variable of `color-pairs.js` (kette-tokens 5.23.2, 51 pairs, unchanged from 5.23.1) is declared in every scope, as the new Community standalone test asks. Still 94 contrast checks; the base blue reproduces Community 0.4.3 exactly, with no adjustment.
- Community 0.4.3 or newer recommended. 0.4.2 works too: the extra variables are harmless and fill the light error and accent colours 0.4.2 left undefined.

## 0.7.0
- New `kette theme` (Community and Enterprise, free): generates a theme.css for `@getitdone-gmbh/kette-design-community` from a brand colour, a drop-in replacement for `@import '@getitdone-gmbh/kette-design-community/theme.css'`. Questions in a terminal, otherwise `--primary <hex>` (required) with `--accent`, `--neutral warm|cool|neutral|<hex>`, `--radius none|sm|md|lg|full|<px>`, `--font`, `--name`, `--out` (default `./theme.css`), `--preview` (self-contained `theme-preview.html` with components in light and dark, palettes and contrast table), `--dry-run` and `--json`. Without a terminal and without `--primary` it stops with exit code 2. A file it did not write is only replaced after a yes or with `--yes`.
- Light and dark in one file with exactly the variables of Community 0.4.2 per block (1343 variables, same selectors): OKLCH tonal palettes from the primary, neutral family, accent surfaces, chart series, radius scale, font, elevation. Status and data colours keep their meaning.
- WCAG 2.2 AA enforced: the 51 fill/text pairs of `color-pairs.js` (kette-tokens 5.23.1, status pairs included), the status and badge pairs of the Community tests, paper, text and focus pairs, 94 checks. Values below 4.5:1 (3:1 for focus rings) get the smallest lightness change, each change is reported, a failing pair is never written. The pair and scope rules of the Community package hold in every block, also for paper inside a dark page. The base blue reproduces Community 0.4.2 exactly.
- Needs Community 0.4.2 or newer: the generated file carries the 0.4.2 variable set.
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
