#!/usr/bin/env bash

set -euo pipefail

if [[ -z "${TUTTI_E2E_SESSION_ID:-}" ]]; then
  echo "TUTTI_E2E_SESSION_ID is required" >&2
  exit 1
fi

app_path="${RUNNER_TEMP}/Applications/Tutti.app"
desktop_binary="${app_path}/Contents/MacOS/Tutti"
tutti_cli="${app_path}/Contents/Resources/bin/tutti"
state_dir="${RUNNER_TEMP}/tutti-agent-e2e-state"
desktop_log="${RUNNER_TEMP}/tutti-agent-e2e-desktop.log"
parser_node="$(command -v node)"

test -x "${desktop_binary}"
test -x "${tutti_cli}"
if [[ -e "${state_dir}" ]]; then
  echo "E2E state directory already exists: ${state_dir}" >&2
  exit 1
fi
mkdir -p "${state_dir}/account"
chmod 700 "${state_dir}" "${state_dir}/account"

TUTTI_E2E_AUTH_PATH="${state_dir}/account/auth.json" \
  "${parser_node}" <<'NODE'
const fs = require("node:fs");
const sessionID = process.env.TUTTI_E2E_SESSION_ID;
const authPath = process.env.TUTTI_E2E_AUTH_PATH;
fs.writeFileSync(
  authPath,
  JSON.stringify({
    session_id: sessionID,
    cookie: `session_id=${sessionID}`
  }),
  { mode: 0o600 }
);
NODE

export TUTTI_ENV=production
export TUTTI_STATE_DIR="${state_dir}"
export TUTTI_APP_RUNTIME_CACHE_ROOT="${state_dir}/app-runtimes"
# Model the affected customer machine: neither node nor tutti-agent is
# discoverable from the desktop process environment.
export PATH="/usr/bin:/bin:/usr/sbin:/sbin"

desktop_pid=""
cleanup() {
  if [[ -n "${desktop_pid}" ]]; then
    kill "${desktop_pid}" >/dev/null 2>&1 || true
    wait "${desktop_pid}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

"${desktop_binary}" >"${desktop_log}" 2>&1 &
desktop_pid="$!"

listener_path="${state_dir}/run/tuttid.listener.json"
for _ in $(seq 1 120); do
  if [[ -s "${listener_path}" ]]; then
    break
  fi
  if ! kill -0 "${desktop_pid}" >/dev/null 2>&1; then
    echo "Tutti Desktop exited before tuttid became ready" >&2
    tail -n 200 "${desktop_log}" >&2 || true
    exit 1
  fi
  sleep 2
done
test -s "${listener_path}"

agents_json=""
for _ in $(seq 1 180); do
  if agents_json="$("${tutti_cli}" agent list --json 2>/dev/null)"; then
    if AGENTS_JSON="${agents_json}" "${parser_node}" <<'NODE'
const payload = JSON.parse(process.env.AGENTS_JSON);
const agent = payload.agents?.find((candidate) => candidate.id === "local:tutti-agent");
process.exit(agent?.availability?.status === "available" ? 0 : 1);
NODE
    then
      break
    fi
  fi
  sleep 3
done

AGENTS_JSON="${agents_json}" "${parser_node}" <<'NODE'
const payload = JSON.parse(process.env.AGENTS_JSON || "{}");
const agent = payload.agents?.find((candidate) => candidate.id === "local:tutti-agent");
if (agent?.availability?.status !== "available") {
  console.error("Tutti Agent did not become available:", JSON.stringify(agent ?? null));
  process.exit(1);
}
console.log(JSON.stringify({
  agentId: agent.id,
  availability: agent.availability.status,
  executableInstalled: Boolean(agent.executablePath)
}));
NODE

start_json="$("${tutti_cli}" agent start \
  --agent-id local:tutti-agent \
  --prompt 'Reply with exactly TUTTI_AGENT_E2E_OK and nothing else.' \
  --cwd "${GITHUB_WORKSPACE}" \
  --show false \
  --json)"
session_id="$(START_JSON="${start_json}" "${parser_node}" <<'NODE'
const payload = JSON.parse(process.env.START_JSON);
const sessionID = payload.agentSessionId ?? payload.session?.agentSessionId ?? "";
if (!sessionID) process.exit(1);
process.stdout.write(sessionID);
NODE
)"

wait_json="$("${tutti_cli}" agent wait \
  --session-id "${session_id}" \
  --timeout-ms 600000 \
  --json)"
WAIT_JSON="${wait_json}" "${parser_node}" <<'NODE'
const payload = JSON.parse(process.env.WAIT_JSON);
if (!JSON.stringify(payload).includes("TUTTI_AGENT_E2E_OK")) {
  console.error("Tutti Agent prompt did not return the expected marker");
  process.exit(1);
}
console.log(JSON.stringify({
  sessionCompleted: true,
  expectedMarkerObserved: true
}));
NODE

grep -E 'tutti_agent\.auth_command\.resolved|tutti_agent\.auth_login\.process_(started|completed)' \
  "${state_dir}/logs/tuttid.log" || true
