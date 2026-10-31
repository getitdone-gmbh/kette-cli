# Ticketing (Enterprise)

Decisions become tickets on the board of a Kette instance and travel down the chain: prototype, tokens, Figma, library, zero, zero-pages, app, backend. Each station gets its own item with an owner, and is checked off with a PR, commit or Figma link. The library is kette-ticketing; it ships in the Enterprise bundle, never in this repo ([ADR-0003](adr/0003-ticketing-from-the-enterprise-bundle.md)).

## Project scope
| What | Where it comes from |
|---|---|
| Board (`adapter`, `project`) | `ticketing` of the repo's instance, through the effective profile (`kette profile --effective`) |
| Stations | `stations` of the instance; none listed means every station kette-ticketing knows |
| Definition of done per station | `routing.json` of the bundle, or `definitionOfDone` of a station object in the instance |
| Members who may decide | `members` of the instance; routes that named the default decider go to the instance owner |
| Station targets | the defaults of the bundle plus the repo names of the instance |
| Credential | `KETTE_TICKETING_WORKBASE_TOKEN` declared in `.kette/wallet.json`, value in your provider; otherwise the agents' shared Workbase session file |
| API | `https://api.workbase.itdone.de/api/project-manager/api`; `KETTE_TICKETING_API` points elsewhere (tests, self-hosted) |

Nothing is read from a global file. The credential never goes into `instance.json`, the repo, a ticket or the screen.

A station in `instance.json` is an id or an object: `"stations": ["prototype", { "id": "app", "definitionOfDone": "Live on shop.acme.example, deploy run checked" }]`.

## Commands
| Command | Does |
|---|---|
| `kette ticket connect [workload-zero] --project <id>` | Shows the plan, then writes `ticketing` into `instance.json` under its lock and declares the credential name in the wallet. One board per project (Q3): a different board is refused |
| `kette ticket new "<words>" --by <member> --source <ref> --stations a,b` | New decision in the words of who decided (`--paraphrase` if not a quote, `--statement`, `--rationale`, `--label`). An accepted session proposal: `--proposed-by <session> --acceptance "<words>"`, the decider stays the member (Q1) |
| `kette ticket list [--member id] [--station s] [--status a,b] [--json]` | Decisions, or items in chain order with a filter |
| `kette ticket show <KD>` | Decision with words, source, items, owners, links |
| `kette ticket edit <KD>` | `--statement`, `--words`, `--rationale`, `--label`; writes a revision |
| `kette ticket extend <KD> --stations a,b [--comment text]` | New station items or a comment |
| `kette ticket route <KD>` | Owners and builders again from the routing of the instance |
| `kette ticket pick <item> --as <member>` | Item to in progress |
| `kette ticket link <item> --pr\|--commit\|--figma\|--review <url>` | Evidence |
| `kette ticket check <item> [--approved-by member]` | Item to done after the chain rules; shows the station's definition of done. Refused while an upstream station is open (Q2) |
| `kette ticket check <KD>` | Follow-through: per station its definition of done and what kette can see is open (status, evidence, batch review link, upstream). Reads only, exit 1 while a station is open |
| `kette ticket close <KD>` | Only when every station is done or not applicable |
| `kette ticket inbox --member <id>` | Open items of one member, upstream first |
| `kette ticket report [--station s] [--json]` | Decided but not yet in prototype or Figma, in progress ahead of upstream, open per station |
| `kette ticket why <subject\|file:line\|commit\|URL\|KD>` | The decision in force with its lineage, revisions and links |
| `kette ticket hook install\|status\|remove` | The intake hook in the project's `.claude/settings.json` |

Every write runs twice: first on a copy of the board, which is the plan `--dry-run` prints, then for real, where each request is compared with the plan before it leaves the machine. A rule refusal stops in the first run, before anything is sent. A write needs a yes in a terminal or `--yes`; without a terminal and without `--yes` nothing is written. `--as` names who acts; inside Claude Code the ticket is marked as written by an agent.

## Setup
`kette init` and `kette add` in a terminal, for a repo of an Enterprise instance without a board, ask after the wallet step whether to connect a workload.zero board. An empty answer skips it. Without a terminal or with `--yes` nothing is asked.

## Intake hook
`kette ticket hook install` adds one `UserPromptSubmit` entry with the command `kette ticket hook run` to `.claude/settings.json` of the project, never to the user settings. That exact command marks the entry as kette's; `remove` takes only it and keeps every other hook and setting. The hook classifies each prompt with the stations and routing of the instance and, for a chain change, tells the session to run kette-intake first and carry the decision through every station to its definition of done, with one batch review at the end. It never blocks: outside an Enterprise instance, on bad input or any error it prints nothing and exits 0. `KETTE_INTAKE_DISABLE=1` turns it off for a session.

## Gates
Each stops with a message and writes nothing: no project in the folder, a Community instance or Community repo ("Ticketing is part of Kette Enterprise"), a repo without instance, no licence, no Enterprise bundle, a bundle without ticketing (`kette update`), a bundle whose library speaks another contract, an instance without a board (`kette ticket connect`), no credential.
