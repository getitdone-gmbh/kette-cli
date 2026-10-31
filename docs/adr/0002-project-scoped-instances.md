# ADR-0002: Project-scoped Kette instances, plugins per project

- **Status:** proposed (defaults of the session, Alex may veto each decision below)
- **Date:** 2026-10-31
- **Refs:** Workbase ZERO-538 (KD-0038), [docs/instances.md](../instances.md), `src/instance/`, `src/project-plugins.mjs`, `src/marketplace.mjs`, `test/sandbox.test.mjs`

## Context
Alex: "köennen wir mehrere gescopte kette-enteprsie oder kette-community instanzen erstellen? im prinzip projektbasiert mit eigenem projektscope?" and "user kann beliebig viele kette projekte laufen lassen". Later: everything must work on project level, not globally.

Until 0.9.4 one machine had one edition, and `kette login`, `update` and `logout` installed the plugins of that edition in the user scope of Claude Code. Every project on the machine saw the same plugins, so a Community project on a licensed machine loaded Enterprise agents, and a machine could not hold an Enterprise and a Community project side by side.

Claude Code (2.1.310, checked in a sandbox HOME) keeps one path per marketplace name for all projects, even when the marketplace is declared in a project: two projects that declare `kette` with different folders repoint each other and the plugins of the first fail to load. It refuses plugin entries that are links leaving the marketplace folder.

## Decision
1. **Instances.** A Kette instance is a folder `~/.kette/instances/<name>/` with `instance.json`: name, edition, optional bundle pin, repos (name and origin URL), members, ticketing (`adapter`, `project`), wallet defaults (`provider`, `project`, `env`), overlays, chain stations. It may be a git clone of an instance repo or a link to one, so the team and Spark agents share it. Any number of instances per machine.
2. **Machine store stays global, everything else per instance or repo.** Global: licence, device ID, bundles (several versions side by side), state (including local checkout paths of instance repos). One licence covers all instances, seats stay per device.
3. **The edition belongs to the instance.** A repo names its instance in `.kette/profile.json` and inherits edition, ticketing, wallet defaults, overlays, stations and the pin; its own values (stack, platform, apps, patterns, flow, overlays) win. `tier` is written to match the instance, also down to Community, because joining an instance is an explicit choice. A Community instance never enables Enterprise plugins or features. An Enterprise instance needs a valid licence.
4. **Plugins per project, never in the user scope.** `.claude/settings.json` switches on the plugins of the project edition and switches off every other Kette plugin; the marketplace path goes into `.claude/settings.local.json` (local scope, git ignored); plugins are installed with project scope. This applies to every repo, with or without instance.
5. **One merged marketplace.** Because a marketplace name is global in Claude Code, kette builds `~/.kette/bundles/marketplace` (name `kette`) from copies of the plugins of all installed bundles, Enterprise winning for plugins both have. Plugin IDs stay `<plugin>@kette`.
6. **Backward compatible.** A repo without `instance` keeps the ADR-0001 rules for its edition. Plugins an older kette installed in the user scope stay; `kette doctor` names them with the uninstall commands.
7. **Never delete an instance repo.** `kette instance remove` needs `--yes`, unlinks a linked instance and refuses a cloned one.

## Alternatives considered
- A marketplace per edition (`kette-community`, `kette-enterprise`): separate by name, but every existing user gets new plugin IDs and the bundles would need renamed manifests. Rejected for now (D2 in docs/instances.md).
- A marketplace per instance, which would also make the bundle pin a real switch: same ID problem, plus one plugin cache per instance. Rejected for now (D6); the pin is a check.
- Keep the user scope and only switch plugins off per project: the user scope would still hold Enterprise plugins on every licensed machine, against the rule "project level, not global".
- Local scope only for the plugin list (`settings.local.json`): nothing committed, but every teammate has to run `kette add` before Claude Code loads anything, and the team does not see which edition a repo uses (D1).
- Remove user-scope plugins of older versions automatically: cleaner, but projects that have not run `kette add` yet would lose their plugins (D5).

## Consequences
- Different repos on one machine can be Community and Enterprise at the same time; a Community repo stays Community after `kette login`.
- `kette login` and `kette update` outside a project change no plugin; each project needs `kette add` (or `kette instance use`) once.
- Claude Code's own registry and cache in `~/.claude/plugins` still change when a project enables plugins; kette cannot avoid that. `~/.npmrc` (npm access per device) and the itdone MCP server of `kette cloud setup` stay in the user scope (D3, D4).
- The profile schema of kette-engineering does not know `instance` yet; the CLI validates the profile without that field until it does (rule gap D8 for the kette-engineering owner).
- This supersedes the part of ADR-0001 that says the edition can only go back to Community by hand: with an instance, `kette instance use` sets it.
