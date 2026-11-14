# ADR-0004: `kette runner` installs the workload.zero runner from the Enterprise bundle

- **Status:** proposed
- **Date:** 2026-11-14
- **Refs:** ZERO-768; KR-14, KR-15, KR-30, KR-36, KR-38, KR-41, KR-45..KR-48; [ADR-0003](0003-ticketing-from-the-enterprise-bundle.md); project-manager-api ADR-0054 (registration contract)

## Context
Customers with a Kette licence connect their own machine as an agent runner to their workload.zero workspace. The runner (zero-agent-runner with zero-wallet) is private code; there are no releases and customers have no access to its GitHub repo. The kette CLI is public, already holds the licence on the machine (`kette login`, one device seat) and already delivers private Enterprise content with checksums (ADR-0003). Windows is not supported by the runner.

## Decision
1. **Delivery.** `scripts/release.mjs` builds zero-agent-runner from a pinned tag (`KETTE_RUNNER_REF`) into the part `runner/` of the Enterprise bundle: one tgz with `dist/`, production `node_modules` (vendored zero-wallet, playwright-core) and `package.json`, plus `runner/manifest.json {version, file, sha256, node}`. The same word filters as for ticketing apply to the own files of the package (everything but `node_modules`); a hit stops the release. The part is opt-in through `KETTE_RUNNER_REF`, so a release without it builds the bundle as before. `--from <tgz> --sha256 <hex>` installs a local package for tests.
2. **Commands.** `kette runner install | update | status | uninstall` in `src/runner/`. `install` checks in this order and writes nothing on failure: platform (win32 ends with "Runners are not supported on Windows in this version. Use macOS or Linux."), a valid Kette sign-in (no extra device seat, no new `/install/token`), Node 22 or newer, `claude` on PATH and signed in without a billable call and without reading credentials, sandbox (bwrap on Linux; otherwise an explicit confirmation or `--accept-unsandboxed`).
3. **Code input.** The one-time code is read from a hidden prompt, or one line from stdin when stdin is not a terminal. `--code` works but warns that the code may stay in the shell history. The CLI never puts the code into a child's argv: it pipes it to `zero-runner register` on stdin, and the runner writes its token (0600, folder 0700) and config (`installedBy: "kette"`, adapter `local`). The CLI does not speak the run protocol itself.
4. **Service.** Linux: systemd user unit `kette-runner.service` (no secrets in `Environment=`, `UMask=0077`), hint for `loginctl enable-linger`. macOS: LaunchAgent `de.itdone.kette-runner.plist`. Service calls go through an injectable exec; tests only compare the files. A runner config without `installedBy: "kette"` (for example the operator's Spark runner) is never replaced, not even with `--replace`.
5. **Defaults the install writes** (added after the runner build, architecture section 15). `--repo owner/name` (repeatable, required; asked for at a terminal) is the local allowlist and stays the customer's trust boundary: the runner never takes repos from the server. The config always carries a capability policy that allows only `repo.write` for those repos. `--wallet file` adds a file wallet (`walletBrand: own`); vault and infisical are configured by hand. The agent's GitHub identity is a fine-grained token of the customer in a file named by `--git-token-file` (mode 600, the CLI never reads it); `--no-agent-push` skips it for tests. `requireProtectedDefaultBranch` stays on.
6. **Uninstall** stops and removes the service, revokes the runner's own token on the server (best effort, reported on failure) and deletes token and config; `--purge` also removes the work folder.

## Alternatives considered
- Download from the public mirror (`kette.itdone.de/dl`): would publish the private runner. Rejected.
- npm package on GitHub Packages: needs registry access on the customer machine and a second version channel next to the bundle (same reasons as ADR-0003).
- The CLI exchanges the code and writes the runner token itself: two implementations of token storage and of the run protocol. Rejected.

## Consequences
The runner follows `kette update` like ticketing; an ended licence stops bundle updates, and the server gate (project-manager-api ADR-0054) stops new runs. Public CI tests the commands against a fake server, a fake `claude` and isolated `HOME`/`KETTE_HOME` on Linux, macOS and Windows (refusal). Review again for Windows runners or hosted runners (stage 2).
