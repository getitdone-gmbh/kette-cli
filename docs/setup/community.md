# Die Kette · Community (free)

Quick start in three steps. Requirement: [Claude Code](https://claude.com/claude-code) is installed.

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

## 2. Connect a project

- New project: `kette init my-project`
- Existing repo: run `kette add` in the repo folder (detects stack and platform)

## 3. Check

```sh
kette doctor
```

## What you get

- Code rules: readability, structure (KISS, DRY, YAGNI, SOLID), errors, tests, security, dependencies, logging, changes, comments
- 7 architecture patterns with an ADR template
- Claude Code plugins `kette-engineering-core` (with the review agent `kette-check`) and `ui-laws` (UI laws, interaction, WCAG 2.2 AA)
- Live deploy to itdone.cloud: `kette cloud setup`

## Stay current

```sh
kette update
```

More: [kette.itdone.de/en/setup](https://kette.itdone.de/en/setup) · Upgrade: [Enterprise](enterprise.md)
