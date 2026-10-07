#!/bin/sh
set -eu

base="${TACK_URL:-https://tack.rex.wf}"
lib="${XDG_DATA_HOME:-$HOME/.local/share}/tack"
bin="$HOME/.local/bin"
skill="$HOME/.agents/skills/tack"

node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' 2>/dev/null || {
  echo "tack needs Node 20+ (https://nodejs.org)" >&2
  exit 1
}

mkdir -p "$lib" "$bin"
curl -fsSL "$base/cli" -o "$lib/tack.mjs.$$"
chmod 755 "$lib/tack.mjs.$$"
mv "$lib/tack.mjs.$$" "$lib/tack.mjs"
ln -sf "$lib/tack.mjs" "$bin/tack"
echo "installed $bin/tack"

if [ -L "$skill" ] || [ -L "$skill/SKILL.md" ]; then
  echo "left $skill alone (it's a symlink)"
else
  mkdir -p "$skill"
  curl -fsSL "$base/skill.md" -o "$skill/SKILL.md.$$"
  mv "$skill/SKILL.md.$$" "$skill/SKILL.md"
  echo "installed $skill/SKILL.md"
fi

case ":$PATH:" in
  *":$bin:"*) ;;
  *) echo "add $bin to your PATH" ;;
esac
echo "next: tack setup --token <token>"
