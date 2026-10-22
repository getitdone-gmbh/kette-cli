# ADR-0001: The flow in .kette/README.md follows the edition of the project

- **Status:** accepted
- **Date:** 2026-10-21
- **Refs:** code review CR-ARCH-1, `src/note.mjs`, `src/cli.mjs`

## Context
`.kette/README.md` lives in the repo and applies to everyone on the team. Until now the text depended on the machine that last ran `kette init`, `add` or `update`: edition and number of agents, skills and commands from the local bundle. A Community machine would have overwritten a team's Enterprise flow, and every new bundle version would have changed the block.

## Decision
The block in `.kette/README.md` follows `tier` in `.kette/profile.json` and contains no numbers. `kette init` sets `tier` to the edition of the machine. `kette add` raises `tier` to the edition of the machine (Community to Enterprise) but never lowers it. `kette update` renews the block according to `tier` without changing the profile. The Enterprise flow itself says which parts of Die Kette are needed on the machine, and `kette doctor` warns when the machine has a lower edition than the project.

## Alternatives considered
- Edition of the machine: simple, but the text in the repo changes with whoever last runs a command.
- Keep numbers in the block: shows a lot, but changes the block with every bundle and belongs in `kette doctor`.
- Lower `tier` as well (e.g. after `kette logout`): a single machine would downgrade a team project.

## Consequences
The block stays stable until someone deliberately changes the edition of the project. Whoever works on an Enterprise project without a licence sees the Enterprise flow with a note on what is missing. Going back to Community is only possible by hand in `.kette/profile.json`. Review again when there are more than two editions.
