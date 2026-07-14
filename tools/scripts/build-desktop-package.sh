#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_DIR="${ROOT_DIR}/apps/desktop"
VARIANT="${1:-unpack}"
DAEMON_BUNDLE_DIR="${APP_DIR}/build/tuttid"
CLI_BUNDLE_DIR="${APP_DIR}/build/tutti"
DESKTOP_BUILD_VERSION="${TUTTI_DESKTOP_BUILD_VERSION:-}"

release_timing_log() {
  echo "[release-timing] $*"
}

run_timed_phase() {
  local phase="$1"
  shift

  local start_seconds="${SECONDS}"
  local exit_code=0
  local status="done"

  release_timing_log "phase=${phase} status=start"
  set +e
  "$@"
  exit_code=$?
  set -e

  if [[ "${exit_code}" -ne 0 ]]; then
    status="failed"
  fi

  release_timing_log "phase=${phase} status=${status} elapsed=$((SECONDS - start_seconds))s"
  return "${exit_code}"
}

has_env() {
  local name="$1"
  [[ -n "${!name:-}" ]]
}

has_notarization_credentials() {
  (
    has_env APPLE_API_KEY &&
      has_env APPLE_API_KEY_ID &&
      has_env APPLE_API_ISSUER
  ) || (
    has_env APPLE_ID &&
      has_env APPLE_APP_SPECIFIC_PASSWORD &&
      has_env APPLE_TEAM_ID
  ) || (
    has_env APPLE_KEYCHAIN_PROFILE
  )
}

has_signing_identity() {
  has_env CSC_LINK ||
    has_env CSC_NAME ||
    security find-identity -p codesigning -v 2>/dev/null | grep -q "Developer ID Application"
}

is_macos_package_variant() {
  [[ "${VARIANT}" == "mac" || "${VARIANT}" == "mac-unsigned" || "${VARIANT}" == "mac-signed" ]]
}

require_macos_packaging_tools() {
  if [[ "$(uname -s)" != "Darwin" ]]; then
    echo "macOS release packaging requires macOS." >&2
    exit 1
  fi

  if ! command -v lipo >/dev/null 2>&1; then
    echo "macOS release packaging requires lipo." >&2
    exit 1
  fi
}

require_signed_macos_release_environment() {
  if [[ "$(uname -s)" != "Darwin" ]]; then
    echo "Signed macOS release packaging requires macOS." >&2
    exit 1
  fi

  if ! has_signing_identity; then
    cat >&2 <<'EOF'
Signed macOS release packaging requires a Developer ID Application signing identity.
Install the certificate in this keychain, or provide CSC_LINK plus CSC_KEY_PASSWORD.
Use "pnpm --filter @tutti-os/desktop build:mac:unsigned" for local packages that do not need Gatekeeper trust.
EOF
    exit 1
  fi

  if ! has_notarization_credentials; then
    cat >&2 <<'EOF'
Signed macOS release packaging requires Apple notarization credentials.
Recommended CI variables: APPLE_API_KEY, APPLE_API_KEY_ID, and APPLE_API_ISSUER.
Use "pnpm --filter @tutti-os/desktop build:mac:unsigned" for local packages that do not need notarization.
EOF
    exit 1
  fi
}

build_macos_universal_go_binary() {
  local package_dir="$1"
  local package_path="$2"
  local output_path="$3"
  local output_name="$4"
  local staging_dir

  staging_dir="$(mktemp -d)"
  (
    cd "${package_dir}"
    GOOS=darwin GOARCH=arm64 go build -o "${staging_dir}/${output_name}-arm64" "${package_path}" &&
      GOOS=darwin GOARCH=amd64 go build -o "${staging_dir}/${output_name}-amd64" "${package_path}"
  ) || {
    rm -rf "${staging_dir}"
    return 1
  }
  lipo -create \
    "${staging_dir}/${output_name}-arm64" \
    "${staging_dir}/${output_name}-amd64" \
    -output "${output_path}" || {
    rm -rf "${staging_dir}"
    return 1
  }
  lipo "${output_path}" -verify_arch arm64 x86_64 || {
    rm -rf "${staging_dir}"
    return 1
  }
  chmod 755 "${output_path}"
  rm -rf "${staging_dir}"
}

prepare_packaged_daemon() {
  rm -rf "${DAEMON_BUNDLE_DIR}" "${CLI_BUNDLE_DIR}"
  mkdir -p "${DAEMON_BUNDLE_DIR}" "${CLI_BUNDLE_DIR}"

  local daemon_output_name="tuttid"
  local cli_output_name="tutti"
  if [[ "${VARIANT}" == "win" ]]; then
    daemon_output_name="tuttid.exe"
    cli_output_name="tutti.exe"
  fi

  if is_macos_package_variant; then
    require_macos_packaging_tools
    build_macos_universal_go_binary \
      "${ROOT_DIR}/services/tuttid" \
      "." \
      "${DAEMON_BUNDLE_DIR}/${daemon_output_name}" \
      "${daemon_output_name}" || return
    build_macos_universal_go_binary \
      "${ROOT_DIR}/apps/cli" \
      "./cmd/tutti" \
      "${CLI_BUNDLE_DIR}/${cli_output_name}" \
      "${cli_output_name}" || return
    return
  fi

  (
    cd "${ROOT_DIR}/services/tuttid"
    go build -o "${DAEMON_BUNDLE_DIR}/${daemon_output_name}" .
  )
  (
    cd "${ROOT_DIR}/apps/cli"
    go build -o "${CLI_BUNDLE_DIR}/${cli_output_name}" ./cmd/tutti
  )
}

prepare_builtin_apps() {
  (
    cd "${ROOT_DIR}"
    pnpm generate:builtin-apps
  )
}

prepare_browser_mcp() {
  # Vendors a pinned chrome-devtools-mcp into build/browser-mcp so packaged
  # browser use never fetches it over the network at runtime. The daemon
  # launcher (resolveBrowserMcpDaemonEnv) points the daemon at the bundle.
  node "${ROOT_DIR}/apps/desktop/scripts/vendor-browser-mcp.mjs"
}

prepare_claude_sdk_sidecar() {
  # Vendors the Claude SDK sidecar into build/claude-sdk-sidecar so packaged
  # Claude SDK sessions do not depend on repository source paths at runtime.
  # The native claude binaries are provisioned by tuttid at runtime and are
  # deliberately absent from the bundle.
  node "${ROOT_DIR}/apps/desktop/scripts/vendor-claude-sdk-sidecar.mjs"
}

run_pnpm_build() {
  pnpm build
}

resolve_desktop_build_version() {
  if [[ -n "${DESKTOP_BUILD_VERSION}" ]]; then
    return
  fi

  DESKTOP_BUILD_VERSION="$(node "${APP_DIR}/scripts/resolve-build-version.mjs")"
  export DESKTOP_BUILD_VERSION
  release_timing_log "desktop_version=${DESKTOP_BUILD_VERSION}"
}

run_electron_builder_unpack() {
  CSC_IDENTITY_AUTO_DISCOVERY=false pnpm exec electron-builder --dir --publish never "-c.extraMetadata.version=${DESKTOP_BUILD_VERSION}"
}

run_electron_builder_mac_unsigned() {
  env \
    -u CSC_LINK \
    -u CSC_KEY_PASSWORD \
    -u CSC_NAME \
    -u APPLE_API_KEY \
    -u APPLE_API_KEY_ID \
    -u APPLE_API_ISSUER \
    -u APPLE_ID \
    -u APPLE_APP_SPECIFIC_PASSWORD \
    -u APPLE_TEAM_ID \
    -u APPLE_KEYCHAIN_PROFILE \
    CSC_IDENTITY_AUTO_DISCOVERY=false \
    pnpm exec electron-builder --mac --x64 --arm64 --universal --publish never -c.mac.notarize=false "-c.extraMetadata.version=${DESKTOP_BUILD_VERSION}"
}

run_electron_builder_mac_signed() {
  pnpm exec electron-builder --mac --x64 --arm64 --universal --publish never -c.mac.notarize=true "-c.extraMetadata.version=${DESKTOP_BUILD_VERSION}"
}

run_electron_builder_win() {
  env \
    npm_package_json="${ROOT_DIR}/package.json" \
    INIT_CWD="${ROOT_DIR}" \
    pnpm exec electron-builder --win --publish never "-c.extraMetadata.version=${DESKTOP_BUILD_VERSION}"
}

run_electron_builder_linux() {
  pnpm exec electron-builder --linux AppImage --publish never "-c.extraMetadata.version=${DESKTOP_BUILD_VERSION}"
}

case "${VARIANT}" in
  unpack|mac|mac-unsigned|mac-signed|win|linux)
    release_timing_log "variant=${VARIANT} status=start"
    run_timed_phase "prepare_builtin_apps" prepare_builtin_apps
    run_timed_phase "prepare_packaged_daemon" prepare_packaged_daemon
    run_timed_phase "prepare_browser_mcp" prepare_browser_mcp
    run_timed_phase "prepare_claude_sdk_sidecar" prepare_claude_sdk_sidecar
    (
      cd "${APP_DIR}"
      run_timed_phase "resolve_desktop_build_version" resolve_desktop_build_version
      run_timed_phase "pnpm_build" run_pnpm_build
      case "${VARIANT}" in
        unpack)
          run_timed_phase "electron_builder_unpack" run_electron_builder_unpack
          ;;
        mac|mac-unsigned)
          run_timed_phase "electron_builder_mac_unsigned" run_electron_builder_mac_unsigned
          ;;
        mac-signed)
          run_timed_phase "require_signed_macos_release_environment" require_signed_macos_release_environment
          run_timed_phase "electron_builder_mac_signed" run_electron_builder_mac_signed
          ;;
        win)
          run_timed_phase "electron_builder_win" run_electron_builder_win
          ;;
        linux)
          run_timed_phase "electron_builder_linux" run_electron_builder_linux
          ;;
      esac
    )
    release_timing_log "variant=${VARIANT} status=done"
    ;;
  *)
    echo "Usage: $0 <unpack|mac|mac-unsigned|mac-signed|win|linux>" >&2
    exit 1
    ;;
esac
