#!/usr/bin/env bash
# Verifies (and optionally regenerates) the shipped claude-agent-acp unified diff.
#
# The bridge `@agentclientprotocol/claude-agent-acp` ships only a bundled
# `dist/acp-agent.js`. Tutti applies a reviewable `git apply`-able diff
# (services/tuttid/service/agentstatus/assets/claude-agent-acp.patch) to it at
# install time — both for the vendored offline bundle and the registry
# fallback. The codemod `patch-claude-agent-acp.mjs` is the *generator* for that
# diff (version-tolerant string anchors), and this script is the CI gate that:
#
#   1. installs the pinned bridge version,
#   2. regenerates the diff from the pristine bundle via the codemod,
#   3. asserts the committed diff matches the regenerated one (drift check),
#   4. asserts the committed diff applies cleanly with `git apply`.
#
# A version bump that breaks an anchor, or a stale committed patch, fails CI
# here — loudly, in a PR — instead of silently on a user's install.
#
# Usage:
#   tools/scripts/verify-claude-acp-patch.sh           # verify (CI default)
#   tools/scripts/verify-claude-acp-patch.sh --write    # regenerate + write patch
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ASSETS_DIR="${ROOT_DIR}/services/tuttid/service/agentstatus/assets"
CODEMOD="${ASSETS_DIR}/patch-claude-agent-acp.mjs"
PATCH_FILE="${ASSETS_DIR}/claude-agent-acp.patch"
# Keep in sync with claudeACPPinnedVersion (Go) and CLAUDE_ACP_VERSION (vendor).
PINNED_VERSION="0.53.0"

WRITE=0
[[ "${1:-}" == "--write" ]] && WRITE=1

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

cat > "${WORK}/package.json" <<EOF
{ "name": "claude-acp-patch-verify", "private": true, "version": "0.0.0",
  "dependencies": { "@agentclientprotocol/claude-agent-acp": "${PINNED_VERSION}" } }
EOF

echo "[verify-claude-acp-patch] installing @agentclientprotocol/claude-agent-acp@${PINNED_VERSION}" >&2
(cd "${WORK}" && npm install --omit=optional --no-audit --no-fund --ignore-scripts >/dev/null 2>&1)

DIST="${WORK}/node_modules/@agentclientprotocol/claude-agent-acp/dist/acp-agent.js"
if [[ ! -f "${DIST}" ]]; then
  echo "[verify-claude-acp-patch] ERROR: bundled dist not found at ${DIST}" >&2
  exit 1
fi

cp "${DIST}" "${WORK}/pristine.js"
node "${CODEMOD}" --dist "${DIST}" >&2
diff -u --label "a/dist/acp-agent.js" --label "b/dist/acp-agent.js" \
  "${WORK}/pristine.js" "${DIST}" > "${WORK}/regenerated.patch" || true

if [[ "${WRITE}" == "1" ]]; then
  cp "${WORK}/regenerated.patch" "${PATCH_FILE}"
  echo "[verify-claude-acp-patch] wrote ${PATCH_FILE}" >&2
  exit 0
fi

if ! diff -q "${PATCH_FILE}" "${WORK}/regenerated.patch" >/dev/null; then
  echo "[verify-claude-acp-patch] ERROR: committed patch is stale." >&2
  echo "  Regenerate with: tools/scripts/verify-claude-acp-patch.sh --write" >&2
  diff -u "${PATCH_FILE}" "${WORK}/regenerated.patch" >&2 || true
  exit 1
fi

# Confirm the committed diff applies cleanly to a fresh pristine bundle.
mkdir -p "${WORK}/applycheck/dist"
cp "${WORK}/pristine.js" "${WORK}/applycheck/dist/acp-agent.js"
(cd "${WORK}/applycheck" && git apply -p1 --check "${PATCH_FILE}")

echo "[verify-claude-acp-patch] OK: patch matches generator and applies cleanly (v${PINNED_VERSION})" >&2
