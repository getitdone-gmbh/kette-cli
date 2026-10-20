#!/bin/sh
# kette Installer: lädt die CLI, prüft die Prüfsumme und legt sie unter ~/.kette ab. Kein sudo, keine Cloud-Aktionen.
set -eu

MIRROR="${KETTE_MIRROR:-https://kette.itdone.de/dl}"
KETTE_HOME="${KETTE_HOME:-$HOME/.kette}"

say() { printf '%s\n' "$*"; }
fail() { printf 'kette: %s\n' "$*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || fail "Node.js 20 oder neuer fehlt. Installieren über https://nodejs.org und erneut starten."
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 20 ] || fail "Node.js $NODE_MAJOR gefunden, gebraucht wird 20 oder neuer."
command -v git >/dev/null 2>&1 || fail "git fehlt."
command -v tar >/dev/null 2>&1 || fail "tar fehlt."

if command -v curl >/dev/null 2>&1; then get() { curl -fsSL "$1" -o "$2"; }
elif command -v wget >/dev/null 2>&1; then get() { wget -qO "$2" "$1"; }
else fail "curl oder wget fehlt."; fi

if command -v sha256sum >/dev/null 2>&1; then sum() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then sum() { shasum -a 256 "$1" | cut -d' ' -f1; }
else fail "sha256sum oder shasum fehlt."; fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

say "kette · Regelwerk und Agenten der Kette"
get "$MIRROR/manifest.json" "$TMP/manifest.json" || fail "Manifest nicht erreichbar: $MIRROR/manifest.json"
VERSION=$(node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(m.cli.version)' "$TMP/manifest.json")
FILE=$(node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(m.cli.url)' "$TMP/manifest.json")
WANT=$(node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(m.cli.sha256)' "$TMP/manifest.json")

say "Lade CLI $VERSION ..."
get "$MIRROR/$FILE" "$TMP/cli.tgz" || fail "Download fehlgeschlagen: $MIRROR/$FILE"
[ "$(sum "$TMP/cli.tgz")" = "$WANT" ] || fail "Prüfsumme stimmt nicht, Installation abgebrochen."

DEST="$KETTE_HOME/cli/$VERSION"
rm -rf "$DEST"
mkdir -p "$DEST" "$KETTE_HOME/bin"
tar -xzf "$TMP/cli.tgz" -C "$DEST"
chmod +x "$DEST/bin/kette.mjs"
ln -sf "$DEST/bin/kette.mjs" "$KETTE_HOME/bin/kette"

say "Installiert: $KETTE_HOME/bin/kette ($VERSION)"
case ":$PATH:" in
  *":$KETTE_HOME/bin:"*) ;;
  *)
    say ""
    say "Noch in den PATH aufnehmen, z. B. in ~/.zshrc oder ~/.bashrc:"
    say "  export PATH=\"$KETTE_HOME/bin:\$PATH\""
    ;;
esac
say ""
say "Weiter mit:"
say "  kette init mein-projekt   neues Projekt"
say "  kette add                 bestehendes Repo anbinden"
