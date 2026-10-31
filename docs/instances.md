# Kette instances

A person or a team can run any number of Kette instances on one machine. Each instance has its own scope: edition, repos, members, ticketing, wallet, rules and chain stations. One licence covers every instance; seats stay per device, the delivery service does not change. Decision: Workbase ZERO-538 (KD-0038), recorded in [ADR-0002](adr/0002-project-scoped-instances.md).

## What lives where

| Place | What | Shared with |
|---|---|---|
| Machine, `~/.kette` | licence (`credentials`), `device-id`, downloaded bundles (`bundles/<edition>/<version>`, several side by side), `state.json`, the merged marketplace folder `bundles/marketplace` | nobody |
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
  "ticketing": { "adapter": "workbase", "project": "ZERO" },
  "wallet": { "provider": "infisical", "project": "acme", "env": "dev" },
  "overlays": [{ "source": "github:acme/rules" }],
  "stations": ["tokens", "library", "apps"]
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
| `ticketing` | no | `adapter` and `project`, read by kette-ticketing; the CLI only checks the shape |
| `wallet` | no | defaults for `kette wallet init` in a repo of the instance: `provider`, `project`, `env` |
| `overlays` | no | same shape as in the profile, inherited when the repo has none |
| `stations` | no | chain stations the instance covers (ids, e.g. `tokens`, `figma`, `library`, `zero`, `pages`, `apps`) |

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

- `.claude/settings.json` (committed, shared with the team) sets `enabledPlugins`: `true` for the plugins of the project edition, `false` for every other Kette plugin, so an Enterprise plugin a machine still has in its user scope does not load in a Community repo. Other settings and plugins of other marketplaces stay untouched.
- The marketplace is declared with local scope (`claude plugin marketplace add --scope local`), which writes its machine path into `.claude/settings.local.json`; kette adds that file to `.gitignore`. Plugins are installed with `claude plugin install <id> --scope project`.
- Claude Code keeps one path per marketplace name for all projects (`~/.claude/plugins/known_marketplaces.json`). Two projects that declare `kette` with different folders repoint each other, and the plugins of the first project fail to load (checked against Claude Code 2.1.310 in a sandbox HOME). So kette builds one merged marketplace `kette` in `~/.kette/bundles/marketplace` from all installed bundles (Enterprise wins for plugins both have), and the project settings decide which plugins load. Plugin IDs stay `<plugin>@kette`. The folder holds copies: Claude Code refuses plugin entries that are links leaving the marketplace folder.
- `kette login` and `kette update` refresh the plugins of the project in the current folder; outside a project they say that plugins are enabled per project. `kette logout` rebuilds the marketplace without the Enterprise plugins, so Enterprise repos keep their settings but those plugins no longer load on this machine.

### Machines set up by kette before 0.10

Earlier versions installed the plugins in the user scope. They are not removed automatically, so projects without their own settings keep working. `kette doctor` names them and gives the uninstall commands to run once every project ran `kette add`. `kette logout` still removes Enterprise plugins from the user scope.

## Onboarding

`kette init` and `kette add` in a terminal, for a folder without a profile, ask which instance the project belongs to: none (the edition of this machine, as before), one of the existing instances, or a new one (name, edition). `--yes` never asks; `--instance <name>` answers it. A project that already has a profile is not asked again. The wallet step of the onboarding (`kette wallet init`) takes provider, project and environment from the instance.

## Bundle pin

`bundle` in `instance.json` is a check. kette keeps one active bundle per edition and one merged marketplace, so two instances of the same edition use the same plugin version; `kette doctor` warns when the pin and the installed version differ. Separate versions per instance would need a marketplace per instance and other plugin IDs (open decision D6).

## Verified: what changes outside the project

`test/sandbox.test.mjs` runs the CLI as its own process with HOME, `~/.kette`, `~/.npmrc` and the Claude Code config folder (`CLAUDE_CONFIG_DIR`) in an empty temp folder, against local fake servers for the delivery service and the mirror (`KETTE_DELIVERY`, `KETTE_MIRROR`), a fake `claude` that keeps scopes the way Claude Code does, and fake `infisical` and `gh`. After every command it compares the whole sandbox. Allowed outside the project:

| Path | Why | Commands |
|---|---|---|
| `~/.kette/credentials`, `device-id`, `state.json`, `bundles/**`, `instances/**` | machine store and the instances themselves | all |
| `~/.claude/plugins/**` | Claude Code's own registry of marketplace names and plugin cache; it changes for project scope installs too and kette cannot avoid it | commands that enable plugins |
| `~/.npmrc` (marked Kette block) | licence-bound npm access per device (open decision D3) | `login`, `update`, `logout` |
| `~/.claude/.claude.json` | the itdone MCP server of `kette cloud setup` in the user scope (open decision D4) | `cloud setup` |

After every command the test also checks that the user settings of Claude Code contain no Kette plugin. The real Claude Code also adds `.claude/settings.local.json` to the global git ignore (`~/.config/git/ignore`) on the first local-scope declaration; that happens in Claude Code, not in kette.

## Test matrix

Result of `KETTE_MATRIX_OUT=<file> node --test test/sandbox.test.mjs` on macOS, Node 24 (2026-10-31): 110 command runs in 10 scenarios, 0 changes outside the allowed list, 0 Kette plugins in the user scope. A cell names the exit code; 1 is the expected refusal in that scenario (for example an Enterprise instance without licence). Green: exit code as expected, nothing global changed beyond the list above, no plugin in the user scope.

Scenarios: A all commands of the help in one sandbox · B two repos in an Enterprise and a Community instance · C a repo switches instance · D repo without instance · E Enterprise instance without licence · F Community instance with licence · G login, update, logout with several instances · H `doctor --instance` with broken repos · I instance from a git repo (local bare repo) and a linked folder · J onboarding in a terminal

| Command | A | B | C | D | E | F | G | H | I | J |
|---|---|---|---|---|---|---|---|---|---|---|
| `kette version` | green 0 | | | | | | | | | |
| `kette help` | green 0 | | | | | | | | | |
| `kette state` | green 0 | | | | | | | | | |
| `kette update` | green 0 | | | | | | green 0 | | | green 0 |
| `kette init` | green 0 | green 0 | green 0 | green 0 | green 0 | green 0 | green 0 | green 0 | green 0 | |
| `kette init` in a terminal (instance question) | | | | | | | | | | green 0 |
| `kette add` | green 0 | | | green 0 | green 1 | | | | | green 0 |
| `kette doctor` | green 0 | green 0 | green 0 | green 0 | green 1 | green 0 | green 0, 1 | | | |
| `kette doctor --ci` | green 0 | | | | | | | | | |
| `kette doctor --instance` | green 0 | | | | | | | green 1 | | |
| `kette rules`, `rules --path` | green 0 | | | | | | | | | |
| `kette profile` | green 0 | | | | | | | | | |
| `kette profile --effective` | green 0 | | | | | | | | green 0 | |
| `kette login` | green 0 | green 0 | green 0 | green 0 | green 0 | green 0 | green 0 | | | |
| `kette logout` | green 0 | | | | green 0 | | green 0 | | | |
| `kette token ci create`, `list`, `revoke` | green 0 | | | | | | | | | |
| `kette figma` | green 0 | | | | | | | | | |
| `kette cloud status`, `cloud setup` | green 0 | | | | | | | | | |
| `kette theme` | green 0 | | | | | | | | | |
| `kette wallet help`, `status`, `add`, `set`, `import`, `run`, `sync github`, `trust`, `remove` | green 0 | | | | | | | | | |
| `kette wallet init` | green 0 | | | | | green 1 | | | | |
| `kette instance` (help), `list` | green 0 | | | | | | | | | |
| `kette instance create` | green 0 | green 0 | green 0 | | green 0, 1 | green 0 | green 0 | green 0 | | |
| `kette instance create --from` | | | | | green 1 | | | | green 0, 1 | |
| `kette instance show` | green 0 | green 0 | | | | | | | | |
| `kette instance use` | green 0 | | green 0 | | | | | | | |
| `kette instance add-repo` | green 0 | | | | | | | | | |
| `kette instance members`, `add`, `remove` | green 0 | | | | | | | | green 0 | |
| `kette instance remove` | green 0 | | | | | | | | green 0, 1 | |

What each scenario asserts beyond the diff: B, the Community repo enables Community plugins only, both instances list only their own repo, the flow texts differ; C, tier, settings and flow follow the instance and the repo leaves the old instance; D, no `instance` field, ADR-0001 still raises the tier after `kette login`; E, nothing is written, the clone of an Enterprise instance repo is removed again, doctor and add name the missing licence; F, only `kette-engineering-core` and `ui-laws` are installed, no project `.npmrc`, no Enterprise templates, the wallet stays locked; G, the merged marketplace gains and loses the Enterprise plugins, the Community repo stays green after logout and the Enterprise repo fails; H, a deleted repo folder and a repo naming another instance fail, the summary counts 1 of 3; I, the inherited ticketing shows in `profile --effective`, a member change asks to commit and push, a clone is never deleted, a link is only unlinked; J, the question creates a new instance, picks an existing one or none, and is not asked again for a connected project.

Not covered by the sandbox: Windows (the fake tools are POSIX scripts; the unit tests run there), the real Claude Code binary (probed by hand, see Plugins per project), a real Infisical and GitHub.

## Open decisions

| ID | Question | Default chosen | Alternative |
|---|---|---|---|
| D1 | Where plugins are enabled | project scope `.claude/settings.json` (shared with the team), marketplace path in local scope | local scope only (nothing committed, every teammate runs `kette add`) |
| D2 | Several editions under one marketplace name | one merged marketplace `kette`, settings decide | a marketplace per edition (`kette-community`, `kette-enterprise`): clean separation, but new plugin IDs for every user |
| D3 | `~/.npmrc` npm token | stays global: bound to licence and device, never in a repo | a token per project `.npmrc` (risk of committing it) |
| D4 | itdone MCP server of `kette cloud setup` | stays user scope: one itdone account per person | local scope per project (setup in every repo) |
| D5 | Plugins of older versions in the user scope | kept, `kette doctor` names them with the uninstall commands | removed by `kette add` or `kette update` automatically |
| D6 | Bundle pin | a check in `kette doctor` | a marketplace per instance with its own version (new plugin IDs) |
| D7 | `tier` when a repo joins a Community instance | follows the instance, also down from Enterprise (explicit choice of the person) | never lower `tier`, as ADR-0001 does without instances |
| D8 | `instance` in the profile schema of kette-engineering | the CLI checks the profile without the field until the schema knows it | rule gap for the kette-engineering owner: add `instance` to `profile.schema.json` |
