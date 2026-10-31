# ADR-0003: Ticketing ships in the Enterprise bundle, the public CLI loads it at runtime

- **Status:** proposed (Alex may veto)
- **Date:** 2026-10-31
- **Refs:** KD-0034, KD-0038, [ADR-0002](0002-project-scoped-instances.md), [docs/ticketing.md](../ticketing.md), Workbase KETTE-6, `scripts/release.mjs`, `src/ticket/`

## Context
KD-0034 puts ticketing into Kette Enterprise: decisions become tickets on the project's board, with adapters for several systems, an intake hook, append-only history and why queries. The library is alexfriedl/kette-ticketing (private, proprietary). kette-cli is public (MIT, getitdone-gmbh/kette-cli), and its npm package and installer reach everyone, also Community users. KD-0038 and ADR-0002: Community never gets Enterprise content, everything runs in project scope, globally only licence, device id, bundles, state, locks and the npm token, and every gate fails closed.

So the ticketing code must reach licensed machines without entering the public repo, the public CLI package or the Community bundle.

## Decision
1. `scripts/release.mjs` builds kette-ticketing from a pinned ref (`KETTE_TICKETING_REF`, default the newest tag `vX.Y.Z`, like the agent pack) out of its git archive, runs `npm ci` and `npm run build`, and copies only what the CLI loads into `ticketing/` of the Enterprise bundle: `dist/` (without comments), the neutral `routing.default.json`, `package.json` and the scripts `cli-facade`, `plan-guard`, `workbase-session`, `intake-hook`, `intake-classify`. `agent/` and `commands/` become the Enterprise plugin `kette-ticketing` (agent `kette-intake`, command `/intake`). The routing, backfill data and migrations of Get IT Done never ship; the release refuses a part that holds a repo of Get IT Done, a session name, a Figma key, a private address or the Spark (`scripts/ticketing-part.mjs`). The bundle version counts the commits of kette-ticketing, and `kette-enterprise.json` names its ref and commit. Publishing needs a tagged ref.
2. The public CLI holds only the glue in `src/ticket/` (argument parsing, project scope, credential lookup, plan and confirmation, hook settings). At runtime it imports one file, `ticketing/scripts/cli-facade.mjs`, from the active Enterprise bundle (`installedBundle('enterprise')`, checksum verified at install), and only when the folder really lies inside `~/.kette/bundles`.
3. A contract number (`CLI_CONTRACT` in the library, `CONTRACT` in `src/ticket/module.mjs`, now 2: neutral routing, station objects, the facade) must match; another number is refused with the next step (update the CLI or the bundle). The release refuses to pack a library with another contract.
4. Gates, in this order, each with a clear message and nothing written: no project; the project's edition is not Enterprise (Community instance or Community repo); the repo has no instance; no licence; no Enterprise bundle; the bundle has no `ticketing/` part.

## Alternatives considered
- **Vendoring the library into kette-cli.** One repo, no runtime loading. Rejected: the code would become public under MIT and reach Community machines, against KD-0038.
- **Private npm package (`@getitdone-gmbh/kette-ticketing`) installed by `kette login`.** Familiar for developers and versioned by npm. Rejected for now: a second channel next to the bundle (registry access, a global install or a per-project dependency), a second version to keep in step, and per-project installs would put Enterprise code into customer repos' `node_modules` and lockfiles. The bundle already has licence-bound delivery, checksums and one active version per edition.
- **A separate binary downloaded on first use.** Rejected: another delivery path and another checksum chain for the same audience the bundle serves.

## Consequences
Ticketing follows the bundle: `kette update` brings a new library, and the CLI and the bundle must agree on the contract. Public CI cannot see the library: it runs the board scenarios that test the CLI (dry run, no token in any file, two instances, missing credential, project ids, session switch) against a public test double of the contract (`test/fixtures/ticketing-double`), and the gate scenarios everywhere. The CI of kette-ticketing runs the ticket scenarios of kette-cli against the real library, so chain rules, approvals, parallel writes and repair are checked on every change there. A real Claude Code run (`KETTE_REAL_CLAUDE=1 node --test test/real-claude-ticket.test.mjs`) proves that an Enterprise repo lists `kette-intake` and a Community repo does not. A release needs a tag in kette-ticketing. Review again when a customer needs ticketing without the rest of the Enterprise bundle.
