#!/bin/sh
# kette Installer: lädt die CLI, prüft die Prüfsumme, legt sie unter ~/.kette ab und ergänzt den PATH. Kein sudo, keine Cloud-Aktionen.
set -eu

MIRROR="${KETTE_MIRROR:-https://kette.itdone.de/dl}"
KETTE_HOME="${KETTE_HOME:-$HOME/.kette}"

say() { printf '%s\n' "$*"; }
fail() { printf 'kette: %s\n' "$*" >&2; exit 1; }

# Startdatei der Login-Shell: zsh, bash, sonst ~/.profile
rc_file() {
  case "$(basename "${SHELL:-sh}")" in
    zsh) printf '%s\n' "$HOME/.zshrc" ;;
    bash) printf '%s\n' "$HOME/.bashrc" ;;
    *) printf '%s\n' "$HOME/.profile" ;;
  esac
}

# Trägt das bin-Verzeichnis in die Startdatei ein, nur wenn es fehlt; KETTE_NO_MODIFY_PATH=1 lässt alles unverändert
add_to_path() {
  BIN="$KETTE_HOME/bin"
  if [ "$BIN" = "$HOME/.kette/bin" ]; then LINE='export PATH="$HOME/.kette/bin:$PATH"'
  else LINE="export PATH=\"$BIN:\$PATH\""; fi
  RC=$(rc_file)
  if [ -f "$RC" ] && grep -qF "$LINE" "$RC"; then return 0; fi
  case ":$PATH:" in *":$BIN:"*) return 0 ;; esac
  if [ "${KETTE_NO_MODIFY_PATH:-}" = "1" ]; then
    say ""
    say "PATH nicht geändert (KETTE_NO_MODIFY_PATH=1). Von Hand ergänzen, z. B. in $RC:"
    say "  $LINE"
    return 0
  fi
  if ! { printf '\n# kette\n%s\n' "$LINE" >> "$RC"; } 2>/dev/null; then
    say ""
    say "$RC ist nicht beschreibbar. Von Hand ergänzen:"
    say "  $LINE"
    return 0
  fi
  say ""
  say "PATH ergänzt in $RC:"
  say "  $LINE"
  say "Neues Terminal öffnen oder einmal ausführen: . \"$RC\""
}

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
add_to_path
say ""
say "Weiter mit:"
say "  kette init mein-projekt   neues Projekt"
say "  kette add                 bestehendes Repo anbinden"
