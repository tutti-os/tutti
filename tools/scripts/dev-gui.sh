#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DESKTOP_APP_DIR="${ROOT_DIR}/apps/desktop"
TUTTID_DIR="${ROOT_DIR}/services/tuttid"
TUTTID_BIN_DIR="${DESKTOP_APP_DIR}/build/tuttid"
NODE_VERSION_FILE="${ROOT_DIR}/.node-version"
GO_MOD_FILE="${TUTTID_DIR}/go.mod"
PACKAGE_JSON_FILE="${ROOT_DIR}/package.json"

export TUTTI_ENV="${DEV_GUI_TUTTI_ENV:-development}"

GO_BIN=""
DEV_GUI_CHILD_PID=""
DEV_GUI_PID_PATH=""
DEV_GUI_INITIAL_TUTTID_PID=""
DEV_GUI_DESKTOP_STARTED=0
DEV_GUI_SHUTDOWN_STARTED=0
DEV_GUI_SHUTDOWN_TIMEOUT_SECONDS="${DEV_GUI_SHUTDOWN_TIMEOUT_SECONDS:-10}"

log() {
  printf '[dev-gui] %s\n' "$*" >&2
}

fail() {
  printf '[dev-gui] %s\n' "$*" >&2
  exit 1
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

prepend_command_dir() {
  local command_path="$1"
  local command_dir

  command_dir="$(dirname "${command_path}")"
  export PATH="${command_dir}:${PATH}"
  hash -r
}

resolve_corepack_command() {
  local node_exec_path
  local node_bin_dir
  local node_version
  local node_platform
  local node_arch
  local local_node_corepack
  local corepack_candidate

  if command_exists corepack; then
    command -v corepack
    return
  fi

  if command_exists node; then
    node_exec_path="$(node -p 'process.execPath' 2>/dev/null || true)"
    if [[ -n "${node_exec_path}" ]]; then
      node_bin_dir="$(dirname "${node_exec_path}")"
      if [[ -x "${node_bin_dir}/corepack" ]]; then
        printf '%s\n' "${node_bin_dir}/corepack"
        return
      fi
    fi

    node_version="$(node -p 'process.versions.node' 2>/dev/null || true)"
    node_platform="$(node -p 'process.platform' 2>/dev/null || true)"
    node_arch="$(node -p 'process.arch' 2>/dev/null || true)"
    if [[ -n "${node_version}" && -n "${node_platform}" && -n "${node_arch}" ]]; then
      local_node_corepack="${HOME}/.local/node-v${node_version}-${node_platform}-${node_arch}/bin/corepack"
      if [[ -x "${local_node_corepack}" ]]; then
        printf '%s\n' "${local_node_corepack}"
        return
      fi
    fi
  fi

  while IFS= read -r corepack_candidate; do
    if [[ -x "${corepack_candidate}" ]]; then
      printf '%s\n' "${corepack_candidate}"
      return
    fi
  done < <(find "${HOME}/.local" -maxdepth 3 -path '*/bin/corepack' 2>/dev/null | sort -r)

  return 1
}

run_go() {
  env -u GOROOT "${GO_BIN}" "$@"
}

is_process_running() {
  local pid="$1"
  local stat

  [[ -n "${pid}" ]] || return 1
  kill -0 "${pid}" >/dev/null 2>&1 || return 1

  stat="$(ps -p "${pid}" -o stat= 2>/dev/null | tr -d '[:space:]' || true)"
  [[ "${stat}" != Z* ]]
}

wait_for_process_exit() {
  local pid="$1"
  local timeout_seconds="$2"
  local deadline=$((SECONDS + timeout_seconds))

  while (( SECONDS < deadline )); do
    if ! is_process_running "${pid}"; then
      return 0
    fi
    sleep 0.2
  done

  return 1
}

resolve_dev_gui_process_group_id() {
  ps -p "$$" -o pgid= 2>/dev/null | tr -d '[:space:]'
}

restore_terminal_foreground() {
  local pgid

  [[ -t 0 && -e /dev/tty ]] || return

  pgid="$(resolve_dev_gui_process_group_id)"
  [[ "${pgid}" =~ ^[0-9]+$ ]] || return

  (
    trap '' TTOU
    perl -MPOSIX=tcsetpgrp -e 'tcsetpgrp(STDIN, int($ARGV[0]))' "${pgid}" \
      < /dev/tty >/dev/null 2>&1 || true
  )
}

wait_for_desktop_dev_exit() {
  local pid="$1"
  local status

  while is_process_running "${pid}"; do
    restore_terminal_foreground
    sleep 0.5
  done

  restore_terminal_foreground

  set +e
  wait "${pid}" >/dev/null 2>&1
  status="$?"
  set -e
  return "${status}"
}

collect_child_processes() {
  local parent_pid="$1"
  local child_pid

  while IFS= read -r child_pid; do
    [[ "${child_pid}" =~ ^[0-9]+$ ]] || continue
    collect_child_processes "${child_pid}"
    printf '%s\n' "${child_pid}"
  done < <(pgrep -P "${parent_pid}" 2>/dev/null || true)
}

stop_process_tree() {
  local pid="$1"
  local signal="$2"
  local pids=()

  if [[ -z "${pid}" ]] || ! is_process_running "${pid}"; then
    return
  fi

  while IFS= read -r child_pid; do
    [[ -n "${child_pid}" ]] || continue
    pids+=("${child_pid}")
  done < <(
    {
      collect_child_processes "${pid}"
      printf '%s\n' "${pid}"
    } | awk '!seen[$0]++'
  )

  if (( ${#pids[@]} == 0 )); then
    return
  fi

  kill "-${signal}" "${pids[@]}" >/dev/null 2>&1 || true
}

read_process_command() {
  local pid="$1"

  ps -p "${pid}" -o comm= -o args= 2>/dev/null | tr -d '\n'
}

is_likely_tuttid_process() {
  local command="$1"
  local part

  [[ -n "${command//[[:space:]]/}" ]] || return 1

  for part in ${command}; do
    case "${part##*/}" in
      tuttid|tuttid.exe)
        return 0
        ;;
    esac
  done

  return 1
}

stop_tuttid_from_pid_file() {
  local pid_path="${DEV_GUI_PID_PATH}"
  local raw_pid
  local pid
  local command

  [[ -n "${pid_path}" ]] || return
  [[ -f "${pid_path}" ]] || return

  raw_pid="$(tr -d '[:space:]' < "${pid_path}" 2>/dev/null || true)"
  [[ "${raw_pid}" =~ ^[0-9]+$ ]] || return

  pid="${raw_pid}"
  if [[ -n "${DEV_GUI_INITIAL_TUTTID_PID}" ]] && [[ "${pid}" == "${DEV_GUI_INITIAL_TUTTID_PID}" ]]; then
    log "leaving pre-existing tuttid pid ${pid} alone"
    return
  fi

  if ! is_process_running "${pid}"; then
    rm -f "${pid_path}"
    return
  fi

  command="$(read_process_command "${pid}" || true)"
  if ! is_likely_tuttid_process "${command}"; then
    log "leaving pid ${pid} alone because it is not a tuttid process"
    return
  fi

  log "stopping managed tuttid pid ${pid}"
  stop_process_tree "${pid}" TERM
  if ! wait_for_process_exit "${pid}" "${DEV_GUI_SHUTDOWN_TIMEOUT_SECONDS}"; then
    log "force stopping managed tuttid pid ${pid}"
    stop_process_tree "${pid}" KILL
    wait_for_process_exit "${pid}" 2 >/dev/null 2>&1 || true
  fi
}

cleanup_dev_gui() {
  if [[ "${DEV_GUI_SHUTDOWN_STARTED}" == "1" ]]; then
    return
  fi
  DEV_GUI_SHUTDOWN_STARTED=1

  if [[ "${DEV_GUI_DESKTOP_STARTED}" == "1" ]] && [[ -n "${DEV_GUI_CHILD_PID}" ]]; then
    log "stopping desktop dev process tree ${DEV_GUI_CHILD_PID}"
    stop_process_tree "${DEV_GUI_CHILD_PID}" TERM
    if ! wait_for_process_exit "${DEV_GUI_CHILD_PID}" "${DEV_GUI_SHUTDOWN_TIMEOUT_SECONDS}"; then
      log "force stopping desktop dev process tree ${DEV_GUI_CHILD_PID}"
      stop_process_tree "${DEV_GUI_CHILD_PID}" KILL
    fi
    wait "${DEV_GUI_CHILD_PID}" >/dev/null 2>&1 || true
  fi

  if [[ "${DEV_GUI_DESKTOP_STARTED}" == "1" ]]; then
    stop_tuttid_from_pid_file
  fi

}

read_tuttid_pid_file() {
  local pid_path="$1"

  [[ -n "${pid_path}" ]] || return 0
  [[ -f "${pid_path}" ]] || return 0
  tr -d '[:space:]' < "${pid_path}" 2>/dev/null || true
}

resolve_tuttid_pid_path() {
  node - "${ROOT_DIR}/config/tutti.defaults.json" <<'NODE'
const { readFileSync } = require("node:fs");
const { homedir } = require("node:os");
const { join } = require("node:path");

const defaults = JSON.parse(readFileSync(process.argv[2], "utf8"));
const explicitPIDPath = process.env.TUTTID_PID_PATH?.trim();
if (explicitPIDPath) {
  console.log(explicitPIDPath);
  process.exit(0);
}

const envValue = process.env.TUTTI_ENV?.trim().toLowerCase();
const isDevelopment =
  envValue === "" ||
  envValue === undefined ||
  envValue === "dev" ||
  envValue === "development" ||
  envValue === "local";
const stateDir =
  process.env.TUTTI_STATE_DIR?.trim() ||
  join(
    homedir(),
    isDevelopment
      ? defaults.state.developmentDirName
      : defaults.state.productionDirName
  );
const runDir =
  process.env.TUTTID_RUN_DIR?.trim() ||
  join(stateDir, defaults.state.runDirName);

console.log(join(runDir, defaults.state.pidFileName));
NODE
}

prepare_dev_gui_runtime() {
  DEV_GUI_PID_PATH="$(resolve_tuttid_pid_path)"
  DEV_GUI_INITIAL_TUTTID_PID="$(read_tuttid_pid_file "${DEV_GUI_PID_PATH}")"
  prepare_managed_posix_shell
  if [[ "$(uname -s)" == "Darwin" ]]; then
    node "${ROOT_DIR}/tools/scripts/prepare-dev-login-protocol.mjs"
  fi
}

prepare_managed_posix_shell() {
  # Workspace app packages keep a stable bootstrap.sh contract. On Windows the
  # daemon executes that contract through the vendored MSYS2 shell; packaged
  # launches discover it from runtime.json, while dev launches need to inject
  # the same absolute path explicitly.
  if [[ "$(node -p 'process.platform')" != "win32" ]]; then
    return
  fi

  if [[ -n "${TUTTI_MANAGED_POSIX_SHELL:-}" ]]; then
    [[ -f "${TUTTI_MANAGED_POSIX_SHELL}" ]] || fail \
      "TUTTI_MANAGED_POSIX_SHELL does not point to a file: ${TUTTI_MANAGED_POSIX_SHELL}"
    log "using managed POSIX shell from TUTTI_MANAGED_POSIX_SHELL=${TUTTI_MANAGED_POSIX_SHELL}"
    return
  fi

  local runtime_root="${DESKTOP_APP_DIR}/build/managed-posix-shell"
  local metadata_path="${runtime_root}/runtime.json"
  local shell_path=""

  if [[ -f "${metadata_path}" ]]; then
    shell_path="$(node - "${metadata_path}" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const metadataPath = process.argv[2];
const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
if (metadata.schemaVersion !== "tutti.managed-posix-shell.v1" || typeof metadata.executable !== "string") {
  process.exit(1);
}
process.stdout.write(path.resolve(path.dirname(metadataPath), metadata.executable));
NODE
    )" || shell_path=""
  fi

  if [[ -z "${shell_path}" ]] || [[ ! -f "${shell_path}" ]]; then
    log "preparing managed POSIX shell for Windows dev GUI"
    node "${DESKTOP_APP_DIR}/scripts/vendor-managed-posix-shell.mjs" \
      --platform=windows-amd64
    shell_path="$(node - "${metadata_path}" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const metadataPath = process.argv[2];
const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
if (metadata.schemaVersion !== "tutti.managed-posix-shell.v1" || typeof metadata.executable !== "string") {
  throw new Error("managed POSIX shell runtime metadata is invalid");
}
process.stdout.write(path.resolve(path.dirname(metadataPath), metadata.executable));
NODE
    )"
  fi

  [[ -f "${shell_path}" ]] || fail \
    "managed POSIX shell executable is missing after preparation: ${shell_path}"
  export TUTTI_MANAGED_POSIX_SHELL="${shell_path}"
  log "using managed POSIX shell for Windows dev GUI: ${TUTTI_MANAGED_POSIX_SHELL}"
}

resolve_required_node_major() {
  tr -d '[:space:]' < "${NODE_VERSION_FILE}"
}

resolve_required_go_minor() {
  sed -nE 's/^go ([0-9]+\.[0-9]+).*/\1/p' "${GO_MOD_FILE}" | head -n 1
}

resolve_required_pnpm_version() {
  sed -nE 's/.*"packageManager":[[:space:]]*"pnpm@([^"]+)".*/\1/p' \
    "${PACKAGE_JSON_FILE}" | head -n 1
}

ensure_node_runtime() {
  local current_node_major=""
  local required_node_major

  required_node_major="$(resolve_required_node_major)"

  if command_exists node; then
    current_node_major="$(node -p 'process.versions.node.split(".")[0]')"
  fi

  if [[ -n "${current_node_major}" ]] && (( current_node_major >= required_node_major )); then
    log "node $(node --version)"
    return
  fi

  if [[ -s "${HOME}/.nvm/nvm.sh" ]]; then
    log "installing Node.js ${required_node_major}.x with nvm"
    # shellcheck disable=SC1090
    source "${HOME}/.nvm/nvm.sh"
    nvm install "${required_node_major}"
    nvm use "${required_node_major}" >/dev/null
    hash -r
    log "node $(node --version)"
    return
  fi

  fail "Node.js ${required_node_major}+ is required. Install nvm or Node.js ${required_node_major}+ and rerun make dev-gui."
}

ensure_pnpm() {
  local required_pnpm_version
  local required_pnpm_semver
  local current_pnpm_version=""
  local corepack_command=""
  local resolved_pnpm_version

  required_pnpm_version="$(resolve_required_pnpm_version)"
  required_pnpm_semver="${required_pnpm_version%%+*}"

  if corepack_command="$(resolve_corepack_command)"; then
    prepend_command_dir "${corepack_command}"
  fi

  if command_exists pnpm; then
    current_pnpm_version="$(pnpm --version 2>/dev/null || true)"
  fi

  if [[ "${current_pnpm_version}" == "${required_pnpm_semver}" ]]; then
    log "pnpm ${current_pnpm_version}"
    return
  fi

  if [[ -z "${corepack_command}" ]] && ! corepack_command="$(resolve_corepack_command)"; then
    fail "corepack is required to install pnpm ${required_pnpm_version} automatically."
  fi

  log "installing pnpm ${required_pnpm_version} with corepack"
  "${corepack_command}" enable
  "${corepack_command}" prepare "pnpm@${required_pnpm_version}" --activate
  prepend_command_dir "${corepack_command}"

  resolved_pnpm_version="$(pnpm --version 2>/dev/null || true)"
  if [[ "${resolved_pnpm_version}" != "${required_pnpm_semver}" ]]; then
    fail "pnpm ${required_pnpm_version} installation did not succeed; found ${resolved_pnpm_version:-unknown version}."
  fi

  log "pnpm ${resolved_pnpm_version}"
}

ensure_go_runtime() {
  local required_go_minor
  local current_go_minor=""
  local brew_formula
  local brew_prefix

  required_go_minor="$(resolve_required_go_minor)"

  if command_exists go; then
    current_go_minor="$(
      env -u GOROOT go version 2>/dev/null | sed -nE 's/^go version go([0-9]+\.[0-9]+).*/\1/p'
    )"
    if [[ "${current_go_minor}" == "${required_go_minor}" ]]; then
      GO_BIN="$(command -v go)"
      log "$(run_go version)"
      return
    fi
  fi

  if [[ "$(uname -s)" != "Darwin" ]] || ! command_exists brew; then
    fail "Go ${required_go_minor}.x is required. Install it and rerun make dev-gui."
  fi

  brew_formula="go@${required_go_minor}"
  if [[ -z "$(brew list --versions "${brew_formula}" 2>/dev/null)" ]]; then
    log "installing ${brew_formula} with Homebrew"
    brew install "${brew_formula}"
  else
    log "using installed ${brew_formula}"
  fi

  brew_prefix="$(brew --prefix "${brew_formula}")"
  GO_BIN="${brew_prefix}/bin/go"
  export PATH="${brew_prefix}/bin:${PATH}"
  hash -r

  current_go_minor="$(
    env -u GOROOT "${GO_BIN}" version 2>/dev/null | sed -nE 's/^go version go([0-9]+\.[0-9]+).*/\1/p'
  )"
  if [[ "${current_go_minor}" != "${required_go_minor}" ]]; then
    fail "expected Go ${required_go_minor}.x after installing ${brew_formula}, found $("${GO_BIN}" version)"
  fi

  log "$(run_go version)"
}

check_runtime_prerequisites() {
  log "checking runtime prerequisites"
  ensure_node_runtime
  ensure_pnpm
  ensure_go_runtime
}

configure_desktop_dev_version() {
  if [[ -n "${TUTTI_APP_VERSION:-}" ]]; then
    log "desktop version ${TUTTI_APP_VERSION} (environment override)"
    return
  fi

  TUTTI_APP_VERSION="$(
    node "${DESKTOP_APP_DIR}/scripts/resolve-build-version.mjs"
  )"
  export TUTTI_APP_VERSION
  log "desktop version ${TUTTI_APP_VERSION}"
}

configure_agent_extension_sources() {
  local package_dir="${DEV_GUI_KIMI_CODE_PACKAGE_DIR:-}"
  local helper_executable="${DEV_GUI_KIMI_CODE_ACCOUNT_USAGE_EXECUTABLE:-}"
  local helper_candidate=""
  local account_usage_profile=""

  if [[ -z "${package_dir}" ]]; then
    # A stale shell or launchd override must not silently shadow the signed
    # remote release used by the shipped product.
    unset TUTTI_AGENT_EXTENSION_KIMI_CODE_PACKAGE_DIR
    unset TUTTI_AGENT_EXTENSION_KIMI_CODE_ACCOUNT_USAGE_EXECUTABLE
    return
  fi

  [[ -d "${package_dir}" ]] || fail \
    "local kimi-code agent extension directory does not exist: ${package_dir}"
  [[ -f "${package_dir}/tutti.agent.json" ]] || fail \
    "local kimi-code agent extension is not an unpacked package (missing tutti.agent.json): ${package_dir}"

  package_dir="$(cd "${package_dir}" && pwd -P)"
  export TUTTI_AGENT_EXTENSION_KIMI_CODE_PACKAGE_DIR="${package_dir}"
  log "using local kimi-code agent extension at ${package_dir}"

  if [[ -z "${helper_executable}" ]]; then
    helper_candidate="${package_dir}/../../../packages/account-usage-probe/dist/cli.cjs"
    if [[ -f "${helper_candidate}" && -x "${helper_candidate}" ]]; then
      helper_executable="${helper_candidate}"
    fi
  fi
  if [[ -z "${helper_executable}" ]]; then
    account_usage_profile="$(
      node -e '
        const fs = require("node:fs");
        const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        process.stdout.write(manifest.profiles?.accountUsage ?? "");
      ' "${package_dir}/tutti.agent.json"
    )" || fail "could not inspect local kimi-code account usage profile"
    if [[ -n "${account_usage_profile}" ]]; then
      fail "local kimi-code account usage helper is missing; build it or set DEV_GUI_KIMI_CODE_ACCOUNT_USAGE_EXECUTABLE"
    fi
    unset TUTTI_AGENT_EXTENSION_KIMI_CODE_ACCOUNT_USAGE_EXECUTABLE
    return
  fi
  [[ -f "${helper_executable}" && -x "${helper_executable}" ]] || fail \
    "local kimi-code account usage helper is not executable: ${helper_executable}"
  helper_executable="$(cd "$(dirname "${helper_executable}")" && pwd -P)/$(basename "${helper_executable}")"
  export TUTTI_AGENT_EXTENSION_KIMI_CODE_ACCOUNT_USAGE_EXECUTABLE="${helper_executable}"
  log "using local kimi-code account usage helper"
}

resolve_tuttid_binary_name() {
  case "$(uname -s)" in
    CYGWIN*|MINGW*|MSYS*)
      printf 'tuttid.exe\n'
      ;;
    *)
      printf 'tuttid\n'
      ;;
  esac
}

resolve_node_process_path() {
  local candidate_path="$1"

  if [[ "$(node -p 'process.platform')" != "win32" ]]; then
    printf '%s\n' "${candidate_path}"
    return
  fi

  if ! command_exists cygpath; then
    fail "cygpath is required to launch Windows processes from the managed POSIX shell."
  fi

  cygpath -w -- "${candidate_path}"
}

ensure_workspace_dependencies() {
  local installed_lockfile="${ROOT_DIR}/node_modules/.pnpm/lock.yaml"
  local workspace_lockfile="${ROOT_DIR}/pnpm-lock.yaml"

  if [[ -d "${ROOT_DIR}/node_modules" ]] && [[ -f "${installed_lockfile}" ]]; then
    if cmp -s "${workspace_lockfile}" "${installed_lockfile}"; then
      log "workspace dependencies already installed"
      return
    fi

    log "workspace dependency lockfile changed; refreshing with pnpm"
  else
    log "installing workspace dependencies with pnpm"
  fi

  (
    cd "${ROOT_DIR}"
    pnpm install
  )
}

prepare_tuttid_binary() {
  local binary_name="$1"
  local binary_path="${TUTTID_BIN_DIR}/${binary_name}"

  mkdir -p "${TUTTID_BIN_DIR}"

  log "generating builtin workspace apps"
  (
    cd "${ROOT_DIR}"
    pnpm generate:builtin-apps
  )

  log "downloading daemon Go modules"
  (
    cd "${TUTTID_DIR}"
    run_go mod download
  )

  log "building daemon dev binary at ${binary_path}"
  (
    cd "${TUTTID_DIR}"
    run_go build -buildvcs=false -o "${binary_path}" .
  )

  TUTTID_BINARY_PATH="${binary_path}"
}

install_dev_cli() {
  log "installing tutti-dev CLI"
  (
    cd "${ROOT_DIR}"
    GO_BIN="${GO_BIN}" node ./tools/scripts/install-dev-cli.mjs
  )
}

start_desktop_dev() {
  local tuttid_bin_path="$1"
  local node_tuttid_bin_path
  local status
  # why-did-you-render instruments every React component and hook. On a real
  # workspace that work can block the renderer for seconds while AgentGUI
  # restores its session directory, which also keeps the Workbench hydration
  # barrier (and therefore the Dock) non-interactive. Keep it opt-in so the
  # normal development path has production-like scheduling characteristics.
  local why_did_you_render="${VITE_TUTTI_WHY_DID_YOU_RENDER:-0}"

  node_tuttid_bin_path="$(resolve_node_process_path "${tuttid_bin_path}")"
  log "starting desktop dev with prebuilt tuttid"
  if [[ "${why_did_you_render}" == "1" ]]; then
    log "why-did-you-render diagnostics enabled"
  fi
  prepare_dev_gui_runtime
  DEV_GUI_DESKTOP_STARTED=1
  (
    cd "${ROOT_DIR}"
    TUTTID_BIN="${node_tuttid_bin_path}" \
      TUTTID_LOG_OUTPUT="${TUTTID_LOG_OUTPUT:-tee}" \
      VITE_TUTTI_WHY_DID_YOU_RENDER="${why_did_you_render}" \
      pnpm dev:desktop < /dev/null
  ) &
  DEV_GUI_CHILD_PID="$!"

  set +e
  wait_for_desktop_dev_exit "${DEV_GUI_CHILD_PID}"
  status="$?"
  set -e
  DEV_GUI_CHILD_PID=""
  return "${status}"
}

main() {
  local binary_name

  check_runtime_prerequisites
  configure_agent_extension_sources
  configure_desktop_dev_version
  ensure_workspace_dependencies

  binary_name="$(resolve_tuttid_binary_name)"
  prepare_tuttid_binary "${binary_name}"
  install_dev_cli

  if [[ "${DEV_GUI_SKIP_START:-0}" == "1" ]]; then
    log "skipping desktop launch because DEV_GUI_SKIP_START=1"
    return
  fi

  start_desktop_dev "${TUTTID_BINARY_PATH}"
}

trap 'exit 130' INT
trap 'exit 143' TERM
trap 'cleanup_dev_gui' EXIT

main "$@"
