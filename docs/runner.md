# Agent runner (Enterprise)

`kette runner` connects one of your machines to your workload.zero workspace as an agent runner. Agents then work on tickets of your workspace on that machine, with your own Claude Code login, and push branches with a GitHub token you create for them. The runner code (zero-agent-runner) ships in the Enterprise bundle, never in this public repo ([ADR-0004](adr/0004-runner-install-from-the-enterprise-bundle.md)).

Runs on Linux and macOS. Windows is not supported in this version.

## Before you start
- Kette signed in on this machine: `kette login <key>` (the runner takes no extra device seat) and a current bundle: `kette update`.
- Node 22 or newer (the Node that runs kette also runs the runner).
- Claude Code installed and signed in: run `claude` once and log in. The native installer is recommended, an npm install outside `/usr` works without sandbox.
- Linux: `bwrap` (bubblewrap) for the agent sandbox, e.g. `sudo apt install bubblewrap`. Without a working sandbox, and always on macOS, agents run without one; the runner names what that means (your home folder with the runner token, your Kette sign-in and your Claude login, your git and gh login, any network address, and that everyone who can assign tickets to agents can run commands on this machine), kette shows that text and asks for a yes or takes `--accept-unsandboxed`. With the sandbox the agents still read your Claude login, claude needs it.
- A one-time runner code from workload.zero: Settings, Agents, Connect runner. It is valid for 15 minutes and works once.
- A fine-grained GitHub token for the agents (below).

## The GitHub token for the agents
The agents push branches and open pull requests with a token that only you create and that only reaches the repos you name.

1. GitHub, Settings, Developer settings, Personal access tokens, Fine-grained tokens, Generate new token.
2. Name it after the machine (for example `kette-runner build-box`), set an expiry (90 days is a good start) and pick the owner of the repos.
3. Repository access: Only select repositories, and select exactly the repos you pass with `--repo`.
4. Repository permissions: Contents read and write, Pull requests read and write. Metadata read is added by GitHub. Nothing else.
5. Generate, then save it in a file only you can read, without echoing it into your shell history:

```sh
mkdir -p ~/.config && install -m 600 /dev/null ~/.config/kette-runner-github-token
${EDITOR:-nano} ~/.config/kette-runner-github-token   # paste the token, save
```

kette checks that the file exists, belongs to you and has mode 600, and passes only its path to the runner. kette never reads the token. With the bwrap sandbox the agents see only this token, never your own git or gh login. Without a sandbox the agents can also reach your own login; the token is then the identity for pushes and for the check that the default branch is protected. Protected default branches stay required: agents never push to them directly.

When the token expires, replace the content of the file and restart the service (`systemctl --user restart kette-runner`, on macOS `launchctl kickstart -k gui/$(id -u)/de.itdone.kette-runner`).

## Install

```sh
kette runner install --repo acme/web --repo acme/api --git-token-file ~/.config/kette-runner-github-token
# Runner code from workload.zero (Settings, Agents, Connect runner; input hidden): ****
```

What it does, in this order, and it stops before reading the code when a check fails:
1. Platform (Linux or macOS), the Kette sign-in, Node 22 or newer, Claude Code installed and signed in (`claude --version`, then `claude auth status` where Claude Code has it, otherwise only whether the credentials exist; no billable call, no credential is read).
2. The repo list, the token file and the wallet option. Without `--repo` kette asks at a terminal; without a terminal it stops with exit 64.
3. The runner package from the Enterprise bundle (`runner/manifest.json`, SHA-256 checked), unpacked to `~/.kette/runner/<version>/` (folders 755, files 644, whatever your umask).
4. A dry run of `zero-runner register` without code: the runner runs its own checks (a sandbox that really works, Claude Code under `CLAUDE_CONFIG_DIR`, the config it would write). Without a working sandbox it answers with its consent text; kette shows it and asks (or takes `--accept-unsandboxed`). Any other refusal stops here, before the code, and a package this attempt unpacked is removed again.
5. The code: hidden prompt at a terminal, one line of stdin otherwise (`--code-stdin`). kette pipes it to `zero-runner register` on stdin; it never appears in an argument, a log or the output.
6. `zero-runner register` exchanges the code for the runner's own token and writes `~/.config/zero-runner/token` (600), `config.json` and `state.json`.
7. `~/.kette/runner/current` points to the new version, then the service `kette-runner` starts.

Service:
- Linux: systemd user unit `~/.config/systemd/user/kette-runner.service` (`systemctl --user daemon-reload`, `enable --now`). A user unit stops when you log out; keep it running with `loginctl enable-linger $USER` (kette shows the hint when linger is off). Log: `journalctl --user -u kette-runner`.
- macOS: LaunchAgent `~/Library/LaunchAgents/de.itdone.kette-runner.plist`, loaded with `launchctl bootstrap gui/<uid>`. Log: `~/Library/Logs/kette-runner.log`.
- The unit and the plist hold no secret; only `PATH` is set, so the runner finds node, claude and git.
- A runner whose token the server refused (removed in workload.zero) ends with exit 3 and is not restarted: the unit has `RestartPreventExitStatus=3`, the LaunchAgent starts the runner through `/bin/sh`, turns exit 3 into a clean exit and leaves `~/.kette/runner/api-refused`. `kette runner status` then says "Runner token revoked, run kette runner install --replace".
- `kette runner install --replace` restarts a running service, so it picks up the new token at once.
- `--no-service` writes the unit or plist but calls no `systemctl`, `launchctl` or `loginctl` (CI and tests); kette prints the command to start it.

Options:

| Option | Meaning |
|---|---|
| `--repo owner/name` | A repo the agents may work on; repeat it or separate with commas. This list on your machine is the trust boundary: a job for another repo is refused |
| `--git-token-file <path>` | The file with the fine-grained GitHub token (mode 600). Required unless `--no-agent-push`; at a terminal kette asks for the path when it is missing (only the path, the token stays in the file) |
| `--no-agent-push` | Agents commit locally and never push; for tests without a token |
| `--wallet file` | An empty file wallet for the agents in `~/.config/zero-runner/wallet` (folder 700). Vault and Infisical are set up by hand after `vendor/zero-wallet/README.md` in the runner package; `--wallet vault` or `infisical` ends with exit 64 |
| `--name <name>` | Name of this machine in workload.zero (default: the host name) |
| `--accept-unsandboxed` | Allow agents without a sandbox (macOS, Linux without bwrap) without asking |
| `--code-stdin` | Read the code from stdin, e.g. `pass show kette-runner-code \| kette runner install --code-stdin ...` |
| `--code <code>` | Works, but the code may stay in your shell history; kette warns |
| `--replace` | Register this machine again with a new code; the old runner token is revoked first |
| `--api <url>` | Another run protocol address, for test servers (also `KETTE_RUNNER_API`) |
| `--from <tgz> --sha256 <hex>` | Install a local runner package instead of the one in the bundle, for tests |
| `--no-service` | Write the service file, but start, stop or reload nothing (also for `update` and `uninstall`) |

What the runner may do: the config allows only `repo.write` for the listed repos. Anything more (CI logs, packages, extra hosts, environment variables) is off; a ticket that needs it ends as `capability_missing`, and you extend the policy by hand after the runner README.

A runner on this machine that kette did not set up (a config without `installedBy: "kette"`) is never changed or removed, not even with `--replace`.

## Status

```sh
kette runner status          # exit 0 only when everything is fine
kette runner status --json
```

Shows the runner version, executor and workspace name, whether the service runs, the last heartbeat (fine below 2 minutes), the licence and whether Claude Code is signed in. It reads `~/.config/zero-runner/state.json`, which the runner keeps; no token or code is in it. A licence that is not active stops new runs until it is active again; running ones finish.

## Update

```sh
kette update                 # loads the new bundle with the new runner
kette runner update          # installs it, moves current, restarts the service
kette runner update --repo acme/web --repo acme/docs   # replace the repo list
```

No code is needed. The repo list goes to `zero-runner update --repo`; the policy follows the list only while kette manages it (marker `policyManagedBy: "kette"` in `config.json`). If you changed the policy by hand and removed the marker, only the list changes.

## Uninstall

```sh
kette runner uninstall           # service, runner token, config, packages
kette runner uninstall --purge   # also the work folder ~/.kette/runner-work
```

Stops and removes the service, then `zero-runner unregister` revokes the runner token on workload.zero and removes token, config and state. If the server cannot be reached, kette says so and removes the local files anyway; remove the runner in workload.zero under Settings, Agents then. The file wallet and your token file stay.

## Exit codes
| Code | Meaning |
|---|---|
| 0 | Done (status: everything fine) |
| 1 | A check failed, the registration was refused, or status found a problem |
| 2 | Wrong usage, or Windows |
| 64 | Missing or invalid `--repo`, `--git-token-file` or `--wallet` |
| 130 | Cancelled at the prompt |

## Release (maintainers)
`npm run release` adds the part `runner/` to the Enterprise bundle only when `KETTE_RUNNER_REF` names a tag of zero-agent-runner (`KETTE_RUNNER`, default `../zero-agent-runner`). It clones that tag, runs `npm ci` and `npm run pack:release`, checks the own files of the package (everything but `node_modules`) with the word filters of ticketing and stops when one hits, then writes `runner/<file>.tgz` and `runner/manifest.json` (`version`, `file`, `sha256`, `node`, `entry`, `protocol`, `platforms`). `private/kette-enterprise.json` names the runner ref, commit, version and checksum. Without `KETTE_RUNNER_REF` the bundle is built exactly as before.
