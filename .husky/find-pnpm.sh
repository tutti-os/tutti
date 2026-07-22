# Resolve pnpm for GUI Git clients (GitHub Desktop, Sourcetree, etc.)
# that inherit a minimal PATH without user shell profile additions.
#
# Sourced by .husky/pre-commit and .husky/pre-push via:
#   . "$(dirname -- "$0")/_/find-pnpm.sh"
#
# This is a project-level fix: it does not modify user shell config and
# works identically in Terminal, VS Code, GitHub Desktop, and CI.

if command -v pnpm >/dev/null 2>&1; then
  return 0 2>/dev/null || exit 0
fi

# Search common macOS/Linux locations for pnpm.
for _dir in \
  "/opt/homebrew/bin" \
  "/usr/local/bin" \
  "$HOME/.local/node24/bin" \
  "$HOME/.local/share/pnpm" \
  "$HOME/.volta/bin" \
  "$HOME/.nvm/versions/node"/*/bin \
  "$HOME/.fnm/aliases"/*/bin \
  "$HOME/.bun/bin"
do
  if [ -x "$_dir/pnpm" ]; then
    export PATH="$_dir:$PATH"
    return 0 2>/dev/null || exit 0
  fi
done

# Last resort: try corepack (ships with Node.js >= 16.10).
if command -v node >/dev/null 2>&1; then
  _node_dir="$(dirname "$(command -v node)")"
  if [ -x "$_node_dir/corepack" ]; then
    export PATH="$_node_dir:$PATH"
    corepack enable pnpm 2>/dev/null
    if command -v pnpm >/dev/null 2>&1; then
      return 0 2>/dev/null || exit 0
    fi
  fi
fi

echo "husky - ERROR: pnpm not found. Install pnpm or add it to PATH." >&2
echo "  See: https://pnpm.io/installation" >&2
exit 127
