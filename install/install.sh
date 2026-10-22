#!/bin/sh
# kette installer: downloads the CLI, verifies the checksum, puts it in ~/.kette and adds it to PATH. No sudo, no cloud actions.
set -eu

MIRROR="${KETTE_MIRROR:-https://kette.itdone.de/dl}"
KETTE_HOME="${KETTE_HOME:-$HOME/.kette}"

say() { printf '%s\n' "$*"; }
fail() { printf 'kette: %s\n' "$*" >&2; exit 1; }

# Startup file of the login shell: zsh, bash, otherwise ~/.profile
rc_file() {
  case "$(basename "${SHELL:-sh}")" in
    zsh) printf '%s\n' "$HOME/.zshrc" ;;
    bash) printf '%s\n' "$HOME/.bashrc" ;;
    *) printf '%s\n' "$HOME/.profile" ;;
  esac
}

# Adds the bin folder to the startup file only when missing; KETTE_NO_MODIFY_PATH=1 leaves everything unchanged
add_to_path() {
  BIN="$KETTE_HOME/bin"
  if [ "$BIN" = "$HOME/.kette/bin" ]; then LINE='export PATH="$HOME/.kette/bin:$PATH"'
  else LINE="export PATH=\"$BIN:\$PATH\""; fi
  RC=$(rc_file)
  if [ -f "$RC" ] && grep -qF "$LINE" "$RC"; then return 0; fi
  case ":$PATH:" in *":$BIN:"*) return 0 ;; esac
  if [ "${KETTE_NO_MODIFY_PATH:-}" = "1" ]; then
    say ""
    say "PATH not changed (KETTE_NO_MODIFY_PATH=1). Add it by hand, e.g. in $RC:"
    say "  $LINE"
    return 0
  fi
  if ! { printf '\n# kette\n%s\n' "$LINE" >> "$RC"; } 2>/dev/null; then
    say ""
    say "$RC is not writable. Add it by hand:"
    say "  $LINE"
    return 0
  fi
  say ""
  say "PATH updated in $RC:"
  say "  $LINE"
  say "Open a new terminal or run once: . \"$RC\""
}

command -v node >/dev/null 2>&1 || fail "Node.js 20 or newer is missing. Install it from https://nodejs.org and start again."
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 20 ] || fail "Found Node.js $NODE_MAJOR, version 20 or newer is required."
command -v git >/dev/null 2>&1 || fail "git is missing."
command -v tar >/dev/null 2>&1 || fail "tar is missing."

if command -v curl >/dev/null 2>&1; then get() { curl -fsSL "$1" -o "$2"; }
elif command -v wget >/dev/null 2>&1; then get() { wget -qO "$2" "$1"; }
else fail "curl or wget is missing."; fi

if command -v sha256sum >/dev/null 2>&1; then sum() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then sum() { shasum -a 256 "$1" | cut -d' ' -f1; }
else fail "sha256sum or shasum is missing."; fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

say "kette · rules and agents of Die Kette"
get "$MIRROR/manifest.json" "$TMP/manifest.json" || fail "Manifest not reachable: $MIRROR/manifest.json"
VERSION=$(node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(m.cli.version)' "$TMP/manifest.json")
FILE=$(node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(m.cli.url)' "$TMP/manifest.json")
WANT=$(node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(m.cli.sha256)' "$TMP/manifest.json")

say "Downloading CLI $VERSION ..."
get "$MIRROR/$FILE" "$TMP/cli.tgz" || fail "Download failed: $MIRROR/$FILE"
[ "$(sum "$TMP/cli.tgz")" = "$WANT" ] || fail "Checksum does not match, installation cancelled."

DEST="$KETTE_HOME/cli/$VERSION"
rm -rf "$DEST"
mkdir -p "$DEST" "$KETTE_HOME/bin"
tar -xzf "$TMP/cli.tgz" -C "$DEST"
chmod +x "$DEST/bin/kette.mjs"
ln -sf "$DEST/bin/kette.mjs" "$KETTE_HOME/bin/kette"

say "Installed: $KETTE_HOME/bin/kette ($VERSION)"
add_to_path
say ""
say "Next:"
say "  kette init my-project   new project"
say "  kette add               connect an existing repo"
