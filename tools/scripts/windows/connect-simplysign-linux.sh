#!/usr/bin/env bash
set -euo pipefail

# SimplySign exposes no supported headless login API. Drive its GUI through an
# isolated Xvfb session and never enable xtrace: this script handles live OTPs.
: "${CERTUM_USER_ID:?CERTUM_USER_ID is required}"
: "${CERTUM_OTP_URI:?CERTUM_OTP_URI is required}"
: "${SS_DIST:?the signer container must define SS_DIST}"
: "${RUNNER_TEMP:?RUNNER_TEMP is required}"

max_attempts="${TSH_CERTUM_LOGIN_MAX_ATTEMPTS:-3}"
launch_seconds="${TSH_CERTUM_LAUNCH_SECONDS:-20}"
retry_delay_seconds="${TSH_CERTUM_LOGIN_RETRY_DELAY_SECONDS:-10}"
case "${max_attempts}" in
  ''|*[!0-9]*) echo "TSH_CERTUM_LOGIN_MAX_ATTEMPTS must be a positive integer." >&2; exit 1 ;;
esac
(( max_attempts >= 1 )) || { echo "TSH_CERTUM_LOGIN_MAX_ATTEMPTS must be at least 1." >&2; exit 1; }

ss_start="$(find "${SS_DIST}" -name SimplySignDesktop_start -type f -print -quit)"
ss_exe="$(find "${SS_DIST}" -name SimplySignDesktop -type f -print -quit)"
ss_pkcs11="$(find "${SS_DIST}" -name 'SimplySignPKCS*.so' -type f -print -quit)"
if [[ -z "${ss_exe}" || -z "${ss_pkcs11}" ]]; then
  echo "SimplySign Desktop or its PKCS#11 module is missing from ${SS_DIST}." >&2
  exit 1
fi

export USER="${USER:-root}"
export DISPLAY=:99
export LD_LIBRARY_PATH="${SS_DIST}:${LD_LIBRARY_PATH:-}"
cp "${SS_DIST}/SimplySignDesktop.xml" "${HOME}/" 2>/dev/null || true
mkdir -p "${HOME}/.config" "${HOME}/.fluxbox"
cat > "${HOME}/.config/Unknown Organization.conf" <<'EOF'
[General]
CacheUserIdAtLogon=Yes
ShowLogonDialogAfterApplicationStartup=Yes
ShowLogonDialogWhenAnyAppRequestsAccess=Yes
EOF
printf 'session.screen0.rootCommand: /bin/true\n' > "${HOME}/.fluxbox/init"

xvfb_pid=''
for display_attempt in $(seq 1 "${max_attempts}"); do
  echo "Starting Xvfb display attempt ${display_attempt}/${max_attempts}."
  Xvfb :99 -screen 0 1280x1024x24 >"${RUNNER_TEMP}/xvfb-attempt-${display_attempt}.log" 2>&1 &
  xvfb_pid=$!
  sleep 3
  if xdpyinfo >/dev/null 2>&1; then break; fi
  kill "${xvfb_pid}" 2>/dev/null || true
  wait "${xvfb_pid}" 2>/dev/null || true
  xvfb_pid=''
  if (( display_attempt < max_attempts )); then sleep "${retry_delay_seconds}"; fi
done
if [[ -z "${xvfb_pid}" ]] || ! xdpyinfo >/dev/null 2>&1; then
  echo "Xvfb display failed after ${max_attempts} attempts." >&2
  exit 1
fi

fluxbox >"${RUNNER_TEMP}/fluxbox.log" 2>&1 &
fluxbox_pid=$!
sleep 2
xdpyinfo >/dev/null

cleanup_failed_session() {
  pkill -TERM -f '[S]implySignDesktop' 2>/dev/null || true
  sleep 2
  pkill -KILL -f '[S]implySignDesktop' 2>/dev/null || true
}
cleanup_display_on_exit() {
  status=$?
  trap - EXIT
  if (( status != 0 )); then
    cleanup_failed_session
    kill "${fluxbox_pid}" "${xvfb_pid}" 2>/dev/null || true
  fi
  exit "${status}"
}
trap cleanup_display_on_exit EXIT

otp_helper="${RUNNER_TEMP}/certum-otp.py"
cat > "${otp_helper}" <<'PY'
import base64
import hashlib
import hmac
import os
import struct
import time
from urllib.parse import parse_qs, urlparse

query = parse_qs(urlparse(os.environ["CERTUM_OTP_URI"]).query)
secret = query["secret"][0]
digits = int(query.get("digits", ["6"])[0])
period = int(query.get("period", ["30"])[0])
algorithm = {"SHA1": hashlib.sha1, "SHA256": hashlib.sha256, "SHA512": hashlib.sha512}[query.get("algorithm", ["SHA1"])[0].upper()]
remaining = period - (time.time() % period)
if remaining < 12:
    time.sleep(remaining + 0.5)
key = base64.b32decode(secret + "=" * ((8 - len(secret) % 8) % 8))
counter = struct.pack(">Q", int(time.time() // period))
digest = hmac.new(key, counter, algorithm).digest()
offset = digest[-1] & 0x0F
value = (int.from_bytes(digest[offset : offset + 4], "big") & 0x7FFFFFFF) % (10**digits)
print(str(value).zfill(digits))
PY

wid=''; bx=0; by=0; bw=0; bh=0
find_simplysign_window() {
  local candidate name area best=0
  wid=''; bx=0; by=0; bw=0; bh=0
  while read -r candidate; do
    [[ -n "${candidate}" ]] || continue
    name="$(xdotool getwindowname "${candidate}" 2>/dev/null || true)"
    case "${name}" in *implySign*) ;; *) continue ;; esac
    eval "$(xdotool getwindowgeometry --shell "${candidate}" 2>/dev/null || true)"
    area=$(( ${WIDTH:-0} * ${HEIGHT:-0} ))
    if (( area > best )); then
      best=${area}; wid=${candidate}; bx=${X:-0}; by=${Y:-0}; bw=${WIDTH:-0}; bh=${HEIGHT:-0}
    fi
  done < <(xdotool search --name '' 2>/dev/null || true)
}

pkcs11_config="${RUNNER_TEMP}/certum-sunpkcs11.conf"
{
  echo 'name = SimplySign'
  echo "library = ${ss_pkcs11}"
  echo 'slotListIndex = 0'
} > "${pkcs11_config}"

certificate_visible() {
  timeout 30 keytool -list -keystore NONE -storetype PKCS11 \
    -providerClass sun.security.pkcs11.SunPKCS11 \
    -providerArg "${pkcs11_config}" -storepass '' 2>/dev/null | grep -q PrivateKeyEntry
}

drive_login_form() {
  local otp
  find_simplysign_window
  [[ -n "${wid}" && "${bw}" -ge 400 && "${bh}" -ge 300 ]] || return 1
  xdotool windowactivate --sync "${wid}" || xdotool windowactivate "${wid}" || true
  xdotool windowraise "${wid}" || true
  sleep 1
  otp="$(python3 "${otp_helper}")"
  echo "::add-mask::${otp}"
  xdotool mousemove $((bx + bw / 2)) $((by + bh * 39 / 100)) click 1
  xdotool key --clearmodifiers ctrl+a
  xdotool key --clearmodifiers Delete
  xdotool type --clearmodifiers --delay 50 "${CERTUM_USER_ID}"
  xdotool key Tab
  xdotool key --clearmodifiers ctrl+a
  xdotool key --clearmodifiers Delete
  xdotool type --clearmodifiers --delay 50 "${otp}"
  xdotool mousemove $((bx + bw / 2)) $((by + bh * 76 / 100)) click 1
  unset otp
  sleep 8
  find_simplysign_window
  [[ -n "${wid}" ]] || return 1
  xdotool windowactivate --sync "${wid}" || true
  xdotool mousemove $((bx + bw / 2)) $((by + bh * 94 / 100)) click 1
  sleep 3
  for poll in $(seq 1 4); do
    if certificate_visible; then
      echo "SimplySign certificate is available (poll ${poll})."
      return 0
    fi
    echo "SimplySign certificate is not available yet (poll ${poll}/4)."
    sleep 3
  done
  return 1
}

connected=false
for attempt in $(seq 1 "${max_attempts}"); do
  cleanup_failed_session
  attempt_log="${RUNNER_TEMP}/simplysign-attempt-${attempt}.log"
  echo "Starting SimplySign login attempt ${attempt}/${max_attempts}."
  if [[ -n "${ss_start}" ]]; then
    "${ss_start}" >"${attempt_log}" 2>&1 &
  else
    "${ss_exe}" >"${attempt_log}" 2>&1 &
  fi
  sleep "${launch_seconds}"
  for window_poll in $(seq 1 30); do
    find_simplysign_window
    if [[ -n "${wid}" && "${bw}" -ge 400 && "${bh}" -ge 300 ]]; then
      echo "SimplySign login window is ready (attempt ${attempt}, poll ${window_poll})."
      break
    fi
    sleep 2
  done
  if [[ -n "${wid}" ]] && drive_login_form; then connected=true; break; fi
  echo "SimplySign login attempt ${attempt}/${max_attempts} failed." >&2
  tail -80 "${attempt_log}" 2>/dev/null || true
  if (( attempt < max_attempts )); then sleep "${retry_delay_seconds}"; fi
done
if [[ "${connected}" != true ]]; then
  echo "SimplySign login failed after ${max_attempts} attempts." >&2
  exit 1
fi
{
  echo "DISPLAY=${DISPLAY}"
  echo "SS_PKCS11=${ss_pkcs11}"
  echo "TSH_CERTUM_PKCS11_CONFIG=${pkcs11_config}"
} >> "${GITHUB_ENV}"
trap - EXIT
echo "SimplySign is connected and ready for Authenticode signing."
