# Kette instances

A person or a team can run any number of Kette instances on one machine. Each instance has its own scope: edition, repos, members, ticketing, wallet, rules and chain stations. One licence covers every instance; seats stay per device, the delivery service does not change. Decision: Workbase ZERO-538 (KD-0038), recorded in [ADR-0002](adr/0002-project-scoped-instances.md).

## What lives where

| Place | What | Shared with |
|---|---|---|
| Machine, `~/.kette` | licence (`credentials`), `device-id`, downloaded bundles (`bundles/<edition>/<version>`, several side by side), `state.json` (with the local checkout paths of instance repos), one marketplace folder per edition (`bundles/marketplace-community`, `bundles/marketplace-enterprise`), short-lived locks in `locks/` | nobody |
| Instance, `~/.kette/instances/<name>/instance.json` | edition, bundle pin, repos, members, ticketing, wallet defaults, overlays, chain stations | the team, when the instance lives in its own git repo |
| Repo | `.kette/profile.json` (names the instance), `.kette/README.md`, `.claude/settings.json` (plugins of the project), `.claude/settings.local.json` (machine path of the marketplace, git ignored), wallet names | everyone who clones the repo |

Nothing project related is written globally. The sandbox test (`test/sandbox.test.mjs`) runs every command of the CLI against an empty HOME and fails when a file outside the project changes that is not on the list in "Verified: what changes outside the project".

## instance.json

```json
{
  "$schema": "https://kette.itdone.de/schema/instance.schema.json",
  "version": 1,
  "name": "acme",
  "edition": "enterprise",
  "bundle": "0.20261025.92",
  "repos": [{ "name": "web", "url": "git@github.com:acme/web.git" }],
  "members": [{ "id": "lead@acme.example", "role": "owner" }],
  "ticketing": { "adapter": "workload-zero", "project": "6ae510fc15371242272a4278" },
  "wallet": { "provider": "infisical", "project": "acme", "env": "dev" },
  "overlays": [{ "source": "github:acme/rules" }],
  "stations": ["prototype", "tokens", "library", { "id": "app", "definitionOfDone": "Live on shop.acme.example, deploy run checked" }]
}
```

| Field | Required | Meaning |
|---|---|---|
| `version` | yes | always 1 |
| `name` | yes | lowercase letters, digits, dashes; equals the folder name |
| `edition` | yes | `enterprise` or `community` |
| `bundle` | no | bundle version the instance expects; `kette doctor` warns when the machine has another one (a check, not a switch) |
| `repos` | no | `name` (folder name) and `url` (git origin). Local checkout paths are never stored here, they differ per machine and live in `state.json` |
| `members` | no | `id` (email or handle) and `role` (`owner` or `member`); information for agents and ticketing, seats stay per device |
| `ticketing` | no | `adapter` (`workload-zero`) and `project` (the board project id); written by `kette ticket connect`, used by every `kette ticket` command in a repo of the instance ([ticketing.md](ticketing.md)) |
| `wallet` | no | defaults for `kette wallet init` in a repo of the instance: `provider`, `project`, `env` |
| `overlays` | no | same shape as in the profile, inherited when the repo has none |
| `stations` | no | chain stations the instance covers: ids (`prototype`, `tokens`, `figma`, `library`, `zero`, `zero-pages`, `app`, `backend`, `atlas`, `engineering`) or objects `{ "id", "definitionOfDone" }` |

Unknown fields are refused, so a typo never passes silently.

## Commands

| Command | Does |
|---|---|
| `kette instance create <name> [--edition enterprise\|community]` | New local instance. Default edition: the edition of this machine. Enterprise needs a valid licence |
| `kette instance create <name> --from <git-url\|folder>` | Clones an instance repo (also a local bare repo) or links a folder that has `instance.json`. Name and edition must match the file; an Enterprise instance without licence is refused and its clone removed |
| `kette instance list` | All instances with edition, repo count and source (`local`, `clone`, `link`); `*` marks the one of the repo in this folder |
| `kette instance show [name]` | Fields, local checkouts and members; `--json` prints the file |
| `kette instance use <name>` | For the repo in this folder: profile names the instance and takes its edition, the flow in `.kette/README.md` follows, `.claude/settings.json` enables exactly the plugins of the edition, the repo is registered with the instance and leaves its previous one |
| `kette instance add-repo [path]` | Registers a repo folder with an instance (`--instance <name>`, otherwise the instance of this folder or the only one) |
| `kette instance members [add <id> [--role owner\|member] \| remove <id>]` | Lists or changes members |
| `kette instance remove <name> --yes` | Removes a local instance, unlinks a linked one (the instance repo stays). A cloned instance repo is never deleted, the CLI names the folder |
| `kette init <folder> --instance <name>`, `kette add --instance <name>` | Connects a project to an instance while setting it up |
| `kette doctor --instance [name]` | Checks the machine once, then every repo of the instance that is checked out here; a missing folder or a repo that names another instance fails |
| `kette profile --effective` | The profile with what it inherits from its instance |

Changes to `instance.json` of a cloned or linked instance end with a hint to commit and push, so the team and the Spark agents see them.

## Inheritance

A repo names its instance in `.kette/profile.json` (`"instance": "acme"`). From the instance it takes the edition (`tier` is written to match, so tools that only read the profile see the right edition), ticketing, wallet defaults, overlays, stations and the bundle pin. Values the repo sets itself win: stack, platform, apps, patterns, flow, overlays. A repo without `instance` behaves as before: its edition follows ADR-0001 (raised to the machine edition by `kette add`, never lowered).

## Editions on one machine

The edition belongs to the instance, not to the machine.

- A Community instance never enables Enterprise plugins, templates, the project `.npmrc` scope line or the secret wallet, even on a machine with a licence.
- An Enterprise instance needs a valid licence on the machine. Without it, `kette instance create`, `use`, `init` and `add` stop with `Instance <name> is Enterprise (Die Kette), this machine has no valid licence. Sign in with: kette login <key>`, and `kette doctor` fails with the same reason.
- `kette update` on a licensed machine also loads the Community bundle when the project in the folder is Community.

## Plugins per project

Claude Code plugins are enabled per project, never in the user scope.

- `.claude/settings.json` (committed, shared with the team) sets `enabledPlugins`: `true` for the plugins of the project edition under the marketplace of that edition, `false` for every other Kette plugin ID, also the IDs of the other edition and the legacy `<plugin>@kette` of versions before 0.10. Other settings and plugins of other marketplaces stay untouched.
- `.claude/settings.local.json` (git ignored, kette adds it to `.gitignore`) declares the marketplace of the edition with its machine path. A local entry that would switch on a plugin the project settings switch off is removed, because local settings win in Claude Code; `kette doctor` reports such an override.
- Plugins are installed with `claude plugin install <plugin>@<marketplace> --scope project`.

### One marketplace per edition

Claude Code keeps one path per marketplace name and one copy per plugin ID for all projects (`~/.claude/plugins/known_marketplaces.json`, the plugin cache; checked with the real Claude Code 2.1.310: `claude plugin list` shows the same `Read from` folder in every repo). A shared name would let a Community repo load the Enterprise copy of a plugin both editions ship, such as `kette-engineering-core`. So each edition has its own marketplace, built only from its own bundle:

| Edition | Marketplace | Folder | Plugin IDs |
|---|---|---|---|
| Community | `kette-community` | `~/.kette/bundles/marketplace-community` | `kette-engineering-core@kette-community`, `ui-laws@kette-community` |
| Enterprise | `kette-enterprise` | `~/.kette/bundles/marketplace-enterprise` | `kette-engineering-core@kette-enterprise`, `kette-engineering@kette-enterprise`, `design-system-agents@kette-enterprise`, `design-review-pack@kette-enterprise` |

The folders hold copies (Claude Code refuses plugin entries that leave the marketplace folder); a link inside a plugin is resolved, a link pointing outside the bundle is left out. On a licensed machine a Community repo makes kette load the Community bundle as well. `kette rules`, `.kette/README.md` and `kette doctor` in a Community repo point only to `~/.kette/bundles/community/`.

When a registered `kette-community` or `kette-enterprise` points to another folder inside `~/.kette` (an earlier build, a moved `KETTE_HOME`), kette repoints it with `claude plugin marketplace add`, which keeps what was installed from it (`marketplace remove` would uninstall its plugins everywhere and empty their entries in the user settings); removals that are needed run from the neutral folder `~/.kette` (run inside a project, Claude Code would also strip the marketplace from its committed `.claude/settings.json`); a folder outside `~/.kette` is never touched and the reason is shown. `kette login` and `kette update` refresh the plugins of the project in the current folder; outside a project they say that plugins are enabled per project. `kette logout` removes the marketplace `kette-enterprise` from Claude Code and its folder, so Enterprise repos keep their settings but those plugins no longer load on this machine.

### Teams on mixed versions

Every member of a team needs kette 0.10 or newer. The committed `.claude/settings.json` switches the `@kette` IDs of older versions off, so a teammate on 0.9 whose plugins sit in the user scope gets no Kette plugins in that repo until they update and run `kette add`.

### Machines set up by kette before 0.10

Earlier versions registered one marketplace `kette` on `~/.kette/bundles/active` and installed the plugins in the user scope. kette leaves that marketplace as it is, so projects without their own settings keep working, and switches its IDs off in every project it sets up. `kette doctor` names user-scope Kette plugins with the uninstall commands to run once every project ran `kette add`. `kette logout` removes the Enterprise plugins an older kette put in the user scope, and only those the user settings really list.

## Fail closed

When a profile names an instance that is missing, damaged or has an unsafe name, the project counts as Community for every gate: plugins, templates, npm and the wallet, never as the edition of the machine. `kette login` and `kette update` warn about such a repo, leave its plugins as they are and finish (licence and npm access are set up first). `kette add`, `kette instance use` and `kette profile --effective` stop with the reason, `kette doctor` fails with it.

## npm access (D3)

The npm token is global per device: the kette block in `~/.npmrc` holds only the `//<registry>/:_authToken=` line. The scope line `@getitdone-gmbh:registry=<kette registry>` lives only in the project `.npmrc` of Enterprise projects, written by `kette init`, `kette add` and `kette instance use` and recorded with its exact text in `.kette/templates.json`. So `npm config get @getitdone-gmbh:registry` in a Community repo is never the Enterprise registry, and an Enterprise repo still installs. A block written before 0.10 still holds the scope line. `kette login` and `kette update` never remove it without a yes: in a terminal they show the line and ask, without a terminal or with `--yes` they keep it and name `kette npm move-scope`, which moves it. Other apps that install `@getitdone-gmbh` packages then need the line in their own `.npmrc`. `kette doctor` fails for an Enterprise project without the line (fix `kette add`) and in a Community instance repo where the global line makes the Enterprise registry resolve (fix `kette npm move-scope`).

## Leaving Enterprise

When a repo joins a Community instance (`kette instance use`, `kette add --instance`), `tier` goes down and kette removes what it wrote for Enterprise: the Enterprise template files it created and recorded with their hash in `.kette/templates.json`, and the scope line it recorded (or, for projects from before the record, the line with the kette registry). Every other line of `.npmrc`, a foreign registry line such as GitHub Packages, and the line endings stay. A template file that was changed since stays and `kette doctor` fails, naming the files. Nothing is deleted through a folder link that points outside the project. A repo without an instance is never touched this way and behaves as before 0.10.

The other way, a Community repo that joins an Enterprise instance gets the scope line from `kette instance use`; the Enterprise templates come with `kette add`, and `kette doctor` names the missing ones until then.

## Repo identity

A repo is identified by its origin, normalised: user info (a token or password) removed, scheme and host lowercased, `git@host:path`, `ssh://` and `https://` forms of the same repo equal, trailing `.git` and `/` removed. Only the normalised URL without user info is written to `instance.json` or printed; `instance.json` refuses a URL with user info. A repo without origin is identified by its git common folder, so a worktree and its main checkout are one repo; its entry in `instance.json` carries a hash of that identity (`local`, no machine path), so it is found again even when a kette was killed before `state.json` was written; two different repos without origin and with the same folder name get distinct names (`web`, `web-2`). A folder inside another repo counts as its own repo.

One repo belongs to one instance: joining with any checkout (`kette instance use`, `kette add --instance`, `kette instance add-repo`) removes it from every other instance. Every local checkout is tracked by path in `state.json`, so `kette doctor --instance` checks each checkout, also a main checkout and its worktrees. Everything that can stop a join (a damaged or read-only `instance.json`, an unwritable `state.json`) is checked before a file of the project is written.

## Several kette processes at once, and a kette that was killed

Every file kette writes into a project (`.kette/profile.json`, the block in `.kette/README.md`, `.claude/settings.json`, `.claude/settings.local.json`, `.gitignore`, `CLAUDE.md`, `.npmrc`, `.kette/templates.json`, `.kette/wallet.json`, templates, `theme.css`, Figma downloads) is written to a temp file next to it, flushed to disk and then renamed into place (a new file is hard-linked, so an existing one is never replaced). A kette killed in the middle leaves the old file or the new one, never an empty or half one. On Windows a rename that is refused for a moment is retried.

What a crash can leave behind and who removes it:

| Left behind | Where | Removed |
|---|---|---|
| A temp file `.<name>.<pid>.<hex>.tmp` | next to the project file | by the next write of that file, once the process is gone |
| A lock `<name>.lck` of the killed process | `~/.kette/locks` | by the next kette that needs the lock (its process is gone) |
| A claim `<name>.lck.<token>.claim` | `~/.kette/locks` | 10 seconds after the crash, by the next kette that needs the lock |
| A temp owner `<name>.lck.<pid>.<hex>.tmp` | `~/.kette/locks` | by the next kette that takes any lock |
| A half-built marketplace `marketplace-<edition>.<pid>.tmp` | `~/.kette/bundles` | by the next build of that marketplace |
| A half-unpacked bundle | `~/.kette/bundles/<edition>/.<version>.<pid>.<hex>.tmp` | by the next unpacking |


Every read-modify-write of a machine file runs under a lock: `state.json`, each `instance.json`, the build of each marketplace folder and the unpacking of each bundle version. A lock is a file `~/.kette/locks/<name>.lck`, hard-linked into place from a temp file that already holds its owner (PID, time, token), so it never appears half written. It is removed only by the one process that claimed its token, the holder at release or a waiter that found it stale (readable owner, process gone or older than 2 minutes); a missing lock is tried again at once. A waiting process gives up after 30 seconds. Temp files of processes that died are removed at the next run. ADR-0002 decision 17 explains the design. Tested with 4 and 8 processes x 100 runs on one lock name with a counter and with a holder killed by SIGKILL, also on Windows. Files are written to a temp file of the own process and renamed. Tested with 6 repos switching instance in parallel for 5 rounds and 4 repos building the marketplaces at once.

## Onboarding

`kette init` and `kette add` in a terminal, for a folder without a profile, ask which instance the project belongs to: none (the edition of this machine, as before), one of the existing instances, or a new one (name, edition). `--yes` never asks; `--instance <name>` answers it. A project that already has a profile is not asked again. The wallet step of the onboarding (`kette wallet init`) takes provider, project and environment from the instance.

## Bundle pin

`bundle` in `instance.json` is a check. kette keeps one bundle in use per edition and one marketplace per edition, so two instances of the same edition use the same plugin version; `kette doctor` warns when the pin and the installed bundle of the instance edition differ, also for a Community instance on a licensed machine. Separate versions per instance would need a marketplace per instance and other plugin IDs (open decision D6).

## Verified: what changes outside the project

`test/sandbox.test.mjs` runs the CLI as its own process with HOME, `~/.kette`, `~/.npmrc` and the Claude Code config folder (`CLAUDE_CONFIG_DIR`) in an empty temp folder, against local fake servers for the delivery service and the mirror (`KETTE_DELIVERY`, `KETTE_MIRROR`), a fake `claude` that keeps scopes the way Claude Code does, and fake `infisical` and `gh`. After every command it compares the whole sandbox. Allowed outside the project:

| Path | Why | Commands |
|---|---|---|
| `~/.kette/credentials`, `device-id`, `state.json`, `bundles/**`, `instances/**`, `locks` | machine store, the instances themselves, locks (empty after every command) | all |
| `~/.claude/plugins/**` | Claude Code's own registry of marketplace names, its plugin cache and `installed_plugins.json` (project-scope entries with their project path); it changes for project-scope installs too and kette cannot avoid it | commands that enable plugins |
| `~/.claude/.claude.json`, `~/.claude/backups/**` | Claude Code keeps its own state and backups there on every run (QA-19); with `kette cloud setup` it also holds the itdone MCP server in the user scope (open decision D4) | every command that runs `claude`, `cloud setup` |
| `~/.npmrc` (marked Kette block, the token only) | npm access per device (D3, decided in fix round 2); `kette npm move-scope` takes the scope line of a block from before 0.10 out of it | `login`, `update`, `logout`, `npm move-scope` |
| `~/.claude/settings.json` | only `kette logout`, and only to remove Enterprise plugins an older kette put in the user scope | `logout` on a machine set up before 0.10 |

After every command the test also checks that the user settings of Claude Code contain no Kette plugin. The real Claude Code also adds `.claude/settings.local.json` to the global git ignore (`~/.config/git/ignore`) on the first local-scope declaration, and `claude plugin list` lists every installed plugin of every project with its status (an Enterprise plugin of another repo shows as disabled in a Community repo, QA-18); that happens in Claude Code, not in kette. `kette logout` removes the marketplace `kette-enterprise` from Claude Code, which uninstalls its plugins in every project (checked with the real Claude Code 2.1.310: `installed_plugins.json` is empty afterwards and `claude plugin list` shows nothing). Claude Code keeps the unused copies in `~/.claude/plugins/cache/kette-enterprise`; kette does not delete inside the Claude Code folder, `kette logout` names the folder instead.

## Test matrix

Result of `KETTE_MATRIX_OUT=<prefix> node --test test/sandbox.test.mjs test/sandbox-qa.test.mjs` on macOS, Node 24 (2026-10-31, fix round 3): 290 command runs in 30 scenarios, 0 changes outside the allowed list, 0 Kette plugins in the user scope (the scenarios MIG and R1 seed plugins of an older kette in the user scope on purpose; `kette logout` removes the Enterprise one, `kette update` keeps the others). The CI runs the same suites on Linux, macOS and Windows with Node 20 and 22; on Windows the tests that need a pseudo terminal, POSIX file modes or symlinks are skipped. A cell names the exit codes; 1 or 2 is the expected refusal in that scenario. Green: exit code as expected, nothing global changed beyond the list above, no plugin in the user scope.

### Scenarios of the first round

A all commands of the help in one sandbox · B two repos in an Enterprise and a Community instance · C a repo switches instance · D repo without instance · E Enterprise instance without licence · F Community instance with licence · G login, update, logout with several instances · H `doctor --instance` with broken repos · I instance from a git repo (local bare repo) and a linked folder · J onboarding in a terminal

| Command | A | B | C | D | E | F | G | H | I | J |
|---|---|---|---|---|---|---|---|---|---|---|
| `kette version` | green 0 |  |  |  |  |  |  |  |  |  |
| `kette help` | green 0 |  |  |  |  |  |  |  |  |  |
| `kette state` | green 0 |  |  |  |  |  |  |  |  |  |
| `kette update` | green 0 |  |  |  |  |  | green 0 |  |  | green 0 |
| `kette doctor` | green 0 | green 0 | green 0 | green 0 | green 1 | green 0 | green 0, 1 |  |  |  |
| `kette init` | green 0 | green 0 | green 0 | green 0 | green 0 | green 0 | green 0 | green 0 | green 0 |  |
| `kette add` | green 0 |  |  | green 0 | green 1 |  |  |  |  | green 0 |
| `kette doctor --ci` | green 0 |  |  |  |  |  |  |  |  |  |
| `kette rules` | green 0 |  |  |  |  |  |  |  |  |  |
| `kette rules --path` | green 0 |  |  |  |  |  |  |  |  |  |
| `kette profile` | green 0 |  |  |  |  |  |  |  |  |  |
| `kette profile --effective` | green 0 |  |  |  |  |  |  |  | green 0 |  |
| `kette theme` | green 0 |  |  |  |  |  |  |  |  |  |
| `kette cloud status` | green 0 |  |  |  |  |  |  |  |  |  |
| `kette cloud setup` | green 0 |  |  |  |  |  |  |  |  |  |
| `kette login` | green 0 | green 0 | green 0 | green 0 | green 0 | green 0 | green 0 |  |  |  |
| `kette token ci create` | green 0 |  |  |  |  |  |  |  |  |  |
| `kette token ci list` | green 0 |  |  |  |  |  |  |  |  |  |
| `kette token ci revoke` | green 0 |  |  |  |  |  |  |  |  |  |
| `kette figma` | green 0 |  |  |  |  |  |  |  |  |  |
| `kette instance` | green 0 |  |  |  |  |  |  |  |  |  |
| `kette instance list` | green 0 |  |  |  |  |  |  |  |  |  |
| `kette instance create` | green 0 | green 0 | green 0 |  | green 0, 1 | green 0 | green 0 | green 0 |  |  |
| `kette instance show` | green 0 | green 0 |  |  |  |  |  |  |  |  |
| `kette instance members add` | green 0 |  |  |  |  |  |  |  | green 0 |  |
| `kette instance members` | green 0 |  |  |  |  |  |  |  |  |  |
| `kette instance members remove` | green 0 |  |  |  |  |  |  |  |  |  |
| `kette instance use` | green 0 |  | green 0 |  |  |  |  |  |  |  |
| `kette instance add-repo` | green 0 |  |  |  |  |  |  |  |  |  |
| `kette doctor --instance` | green 0 |  |  |  |  |  |  | green 1 |  |  |
| `kette wallet help` | green 0 |  |  |  |  |  |  |  |  |  |
| `kette wallet init` | green 0 |  |  |  |  | green 1 |  |  |  |  |
| `kette wallet status` | green 0 |  |  |  |  |  |  |  |  |  |
| `kette wallet add` | green 0 |  |  |  |  |  |  |  |  |  |
| `kette wallet set` | green 0 |  |  |  |  |  |  |  |  |  |
| `kette wallet import` | green 0 |  |  |  |  |  |  |  |  |  |
| `kette wallet run` | green 0 |  |  |  |  |  |  |  |  |  |
| `kette wallet sync` | green 0 |  |  |  |  |  |  |  |  |  |
| `kette wallet trust` | green 0 |  |  |  |  |  |  |  |  |  |
| `kette wallet remove` | green 0 |  |  |  |  |  |  |  |  |  |
| `kette instance remove` | green 0 |  |  |  |  |  |  |  | green 0, 1 |  |
| `kette logout` | green 0 |  |  |  | green 0 |  | green 0 |  |  |  |
| `kette instance create --from` |  |  |  |  | green 1 |  |  |  | green 0, 1 |  |
| `kette init (terminal)` |  |  |  |  |  |  |  |  |  | green 0 |

### Regression scenarios of fix round 1

D2 Community repo on a licensed machine loads and names only Community content · FC fail closed with a missing or damaged instance (five kinds of damage) · D7 leaving Enterprise · ID repo identity, one instance per repo, same names, worktrees · LK 6 repos x 5 rounds in parallel and a parallel first marketplace build (the 34 parallel runs are checked in the test and not counted in the table) · Q9 checks before writing · SEC tokens, transports, control characters · MIG machine set up before 0.10 · RM dangling and damaged instances · MISC bundle pin, missing instance, corrupt profile, inherited overlays · OB onboarding with a wrong answer and a taken name · PLAT user scope and git ignore on every platform · fix round 2: LO logout inside an Enterprise repo · NPM token global, scope line per project (real npm) · FR foreign scope line with CRLF in a repo without instance · UP Community repo joins an Enterprise instance · R1 leftovers of the first 0.10 build · OB2 wrong edition answer and n at the plan · fix round 3: SC global scope line kept without consent, moved by kette npm move-scope · KILL 5 runs of 40 SIGKILLs on repos without origin (the killed runs are not counted in the table)

| Command | D2 | FC | D7 | ID | LK | Q9 | SEC | MIG | RM | MISC | OB | PLAT | LO | NPM | FR | UP | R1 | OB2 | SC | KILL |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `kette login` | green 0 | green 0 | green 0 |  | green 0 |  |  | green 0 |  | green 0 |  | green 0 | green 0 | green 0 |  | green 0 |  |  | green 0 |  |
| `kette instance create` | green 0 | green 0 | green 0 | green 0 | green 0 | green 0 | green 0 | green 0 |  | green 0 | green 0 | green 0 | green 0 | green 0 | green 0 | green 0 |  |  | green 0 | green 0 |
| `kette init` | green 0 | green 0 | green 0 | green 0 | green 0 | green 0, 1 | green 0 | green 0 |  | green 0 |  | green 0 | green 0 | green 0 | green 0 | green 0 |  |  | green 0 | green 0 |
| `kette rules --path` | green 0 |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `kette rules` | green 0 |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `kette doctor` | green 0 | green 1 | green 0, 1 |  |  |  |  | green 0 |  | green 0 |  |  |  |  | green 0 | green 0 | green 0 |  | green 0, 1 |  |
| `kette wallet init` |  | green 1 |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `kette update` |  | green 0 |  | green 0 | green 0 | green 0 | green 0 |  |  |  | green 0 |  |  |  |  |  | green 0 | green 0 | green 0 | green 0 |
| `kette profile --effective` |  | green 1 |  |  |  |  |  |  |  | green 1 |  |  |  |  |  |  |  |  |  |  |
| `kette add` |  | green 1 |  | green 0 |  |  |  |  |  |  |  |  |  |  | green 0 | green 0 |  |  |  |  |
| `kette instance remove` |  | green 0 |  |  |  |  |  |  | green 0 |  |  |  |  |  |  |  |  |  |  |  |
| `kette instance use` |  |  | green 0 |  |  |  | green 0 |  |  |  |  |  |  |  | green 0 | green 0 |  |  |  |  |
| `kette instance add-repo` |  |  |  | green 0 |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `kette doctor --instance --ci` |  |  |  | green 0 |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `kette instance show` |  |  |  |  |  |  | green 0 |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `kette instance create --from` |  |  |  |  |  |  | green 1 |  | green 0, 1 |  |  |  |  |  |  |  |  |  |  |  |
| `kette instance members add` |  |  |  |  |  |  | green 2 |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `kette logout` |  |  |  |  |  |  |  | green 0 |  |  |  |  | green 0 |  |  |  |  |  |  |  |
| `kette instance list` |  |  |  |  |  |  |  |  | green 0 |  |  |  |  |  |  |  |  |  |  |  |
| `kette doctor --instance` |  |  |  |  |  |  |  |  |  | green 1 |  |  |  |  |  |  |  |  |  |  |
| `kette init (terminal)` |  |  |  |  |  |  |  |  |  |  | green 0, 1 |  |  |  |  |  |  |  |  |  |
| `kette npm` |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | green 0 |  |
| `kette update (terminal)` |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | green 0 |  |

Each regression test of fix round 1 was run against the code of the first round (9bab850) and failed there, all 13; each test of fix round 2 against 60b7cc5 and failed there (CR-NEW-2 tests a function that did not exist before); each test of fix round 3 against 1bf4f5b, where the lock tests (8 processes, SIGKILL of a holder) and the deterministic QA-29 test failed. The multi-process lock tests in test/lock.test.mjs run in the CI on Linux, macOS and Windows. The logs are kept with the fix round notes.

## Open decisions

| ID | Question | Default chosen | Alternative |
|---|---|---|---|
| D1 | Where plugins are enabled | project scope `.claude/settings.json` (shared with the team), marketplace path in local scope | local scope only (nothing committed, every teammate runs `kette add`) |
| D2 | Several editions under one marketplace name | decided in fix round 1: one marketplace per edition (`kette-community`, `kette-enterprise`), the legacy `kette` stays for old projects | one merged marketplace (a Community repo would load Enterprise copies of shared plugins) |
| D3 | `~/.npmrc` npm token | decided in fix round 2: the token stays global per device, the scope line only in the project `.npmrc` of Enterprise projects | a token per project `.npmrc` (risk of committing it) |
| D4 | itdone MCP server of `kette cloud setup` | stays user scope: one itdone account per person | local scope per project (setup in every repo) |
| D5 | Plugins of older versions in the user scope | kept, `kette doctor` names them with the uninstall commands | removed by `kette add` or `kette update` automatically |
| D6 | Bundle pin | a check in `kette doctor` | a marketplace per instance with its own version (more IDs, one cache entry per instance) |
| D7 | `tier` when a repo joins a Community instance | decided in fix round 1: follows the instance, also down from Enterprise, and kette removes the Enterprise files it wrote (see Leaving Enterprise) | never lower `tier`, as ADR-0001 does without instances |
| D8 | `instance` in the profile schema of kette-engineering | the CLI checks the profile without the field until the schema knows it | rule gap for the kette-engineering owner: add `instance` to `profile.schema.json` |
