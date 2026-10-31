# Die Kette · Enterprise

Quick start in five steps. Requirements: [Claude Code](https://claude.com/claude-code) is installed and you have a licence key (`CDP-XXXXX-XXXXX-XXXXX-XXXXX`).

## 1. Install the CLI

macOS / Linux:

```sh
curl -fsSL https://kette.itdone.de/install | sh
```

Windows (PowerShell):

```powershell
irm https://kette.itdone.de/install.ps1 | iex
```

Then open a new terminal.

## 2. Activate

```sh
kette login CDP-XXXXX-XXXXX-XXXXX-XXXXX
```

Downloads the Enterprise bundle. Each device takes one seat of the licence (Solo 3, Team 20); one licence covers every Kette instance on the device.

## 3. Connect a project

- New project: `kette init my-project`
- Existing repo: `kette add` (repos already connected get the Enterprise templates this way)

Each project enables its own Claude Code plugins in `.claude/settings.json`: `kette-engineering-core`, `kette-engineering`, `design-system-agents` and `design-review-pack`. Several projects with their own scope (edition, repos, members, ticketing, wallet): `kette instance create <name>`, then `kette init my-project --instance <name>`, see [instances](../instances.md). A Community instance stays Community on this device.

## 4. Install the design system packages

`kette login` added npm access to `~/.npmrc`. In your project:

```sh
npm install @getitdone-gmbh/kette-design-enterprise
```

The registry also serves `@getitdone-gmbh/kette-tokens`, `@getitdone-gmbh/zero` and `@getitdone-gmbh/zero-pages`.

## 5. Secret wallet

`kette init` and `kette add` offer it at the end. Later, or in another repo:

```sh
kette wallet init
```

Infisical by default: kette checks the Infisical CLI, asks for the region (EU, US or your own instance), starts `infisical login` if needed and lets you pick the project with `infisical init`. The repo gets `.kette/wallet.json` with the names only.

Existing `.env` file? Move it over and start without it:

```sh
kette wallet import .env --env dev
kette wallet run --env dev -- npm run dev
```

## 6. Check

```sh
kette doctor
```

Shows edition, version and update period.

## What you get on top

- 26 agents, 18 skills and 5 commands, and the code reviewer as a review gate
- Stack and platform profiles with CI, Docker and check templates
- 132 UX/UI rules, 52 of them with do and don't examples, plus 17 consistency checkpoints
- Private npm packages (tokens, component library, domain components, page templates)
- Secret wallet for credentials and access: `kette wallet init` (Infisical by default, or Vault, AWS Secrets Manager, Azure Key Vault, your own commands)
- 12 months of updates

## Useful

| Command | Purpose |
|---|---|
| `kette update` | Get the latest version (within the update period) |
| `kette logout` | Hand over the machine: removes key, bundle and npm access |
| `kette token ci create <name>` | CI token for `npm ci` in your pipeline |
| `kette doctor --ci` | Check in your pipeline |
| `kette wallet init` | Secret wallet: names in `.kette/wallet.json`, values in Infisical or your own provider |
| `kette wallet run --env dev -- npm run dev` | Start with the secrets of an environment, nothing in a `.env` file |

More: [kette.itdone.de/en/enterprise](https://kette.itdone.de/en/enterprise) · Without a licence: [Community](community.md)
