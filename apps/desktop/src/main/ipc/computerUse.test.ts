import assert from "node:assert/strict";
import test from "node:test";
import {
  parseCuaDriverDoctorStatus,
  parseCuaDriverPermissionsStatus,
  parseCuaDriverPermissionsStatusDetail,
  resolveCuaDriverAuthorizationStatus
} from "./computerUsePermissions.ts";
import { buildWindowsCuaDriverCommand } from "./computerUseWindows.ts";

test("Windows computer-use install avoids invisible UAC prompts", () => {
  const command = buildWindowsCuaDriverCommand(
    "install",
    "https://cua.ai/driver/install.ps1"
  );
  assert.equal(command.command, "powershell.exe");
  assert.deepEqual(command.args.slice(0, 5), [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass"
  ]);
  const script = command.args.at(-1) ?? "";
  assert.match(script, /CUA_DRIVER_RS_VERSION/iu);
  assert.match(script, /\[scriptblock\]::Create/iu);
  assert.match(script, /-NoAutoStart/iu);
  assert.doesNotMatch(script, /Invoke-Expression/iu);
});

test("Windows computer-use uninstall forces non-interactive cleanup", () => {
  const command = buildWindowsCuaDriverCommand(
    "uninstall",
    "https://cua.ai/driver/uninstall.ps1"
  );
  const script = command.args.at(-1) ?? "";
  assert.match(script, /CUA_DRIVER_RS_UNINSTALL_FORCE = '1'/u);
  assert.match(script, /\[scriptblock\]::Create/iu);
  assert.doesNotMatch(script, /-NoAutoStart/iu);
});

test("parseCuaDriverDoctorStatus maps a healthy Windows driver", () => {
  assert.deepEqual(
    parseCuaDriverDoctorStatus(
      JSON.stringify({
        ok: true,
        probes: [{ label: "UI Automation", status: "ok" }]
      })
    ),
    { ok: true }
  );
});

test("parseCuaDriverDoctorStatus preserves failed probe diagnostics", () => {
  assert.deepEqual(
    parseCuaDriverDoctorStatus(
      JSON.stringify({
        probes: [
          { label: "UI Automation", status: "ok" },
          { label: "Interactive session", status: "error", message: "denied" }
        ]
      })
    ),
    { ok: false, diagnosticMessage: "Interactive session: denied" }
  );
});

test("parseCuaDriverDoctorStatus recognizes usable Win32 fallback", () => {
  assert.deepEqual(
    parseCuaDriverDoctorStatus(
      JSON.stringify({
        ok: false,
        message:
          "UIA health probe exceeded 2000ms; falling back to Win32-only window tools"
      })
    ),
    {
      ok: false,
      degraded: true,
      diagnosticMessage:
        "UIA health probe exceeded 2000ms; falling back to Win32-only window tools"
    }
  );
});

test("parseCuaDriverDoctorStatus recognizes Win32 fallback emitted before JSON", () => {
  const warning =
    "\u001b[33mWARN\u001b[0m UIA health probe exceeded 2000ms; falling back to Win32-only window tools";
  assert.deepEqual(
    parseCuaDriverDoctorStatus(
      [
        warning,
        JSON.stringify({
          ok: false,
          probes: [
            {
              label: "binary",
              message: "cua-driver 0.18.0 (x86_64-windows)",
              status: "ok"
            }
          ]
        })
      ].join("\n")
    ),
    { ok: false, degraded: true }
  );

  assert.deepEqual(parseCuaDriverDoctorStatus(`${warning}\nnot json`), {
    ok: false,
    diagnosticMessage: `${warning}\nnot json`
  });
});

test("parseCuaDriverPermissionsStatus maps driver-daemon permission payload", () => {
  assert.deepEqual(
    parseCuaDriverPermissionsStatus(
      JSON.stringify({
        accessibility: true,
        screen_recording: false,
        screen_recording_capturable: true,
        source: {
          attribution: "driver-daemon"
        }
      })
    ),
    {
      accessibility: true,
      screenRecording: false,
      screenRecordingCapturable: true,
      source: "driver-daemon"
    }
  );
});

test("parseCuaDriverPermissionsStatus tolerates surrounding diagnostic output", () => {
  assert.deepEqual(
    parseCuaDriverPermissionsStatus(
      [
        "cua-driver diagnostic",
        JSON.stringify({
          accessibility: true,
          screen_recording: true,
          screen_recording_capturable: true,
          source: {
            attribution: "driver-daemon"
          }
        })
      ].join("\n")
    ),
    {
      accessibility: true,
      screenRecording: true,
      screenRecordingCapturable: true,
      source: "driver-daemon"
    }
  );
});

test("parseCuaDriverPermissionsStatus falls back for invalid payloads", () => {
  assert.equal(parseCuaDriverPermissionsStatus("not json"), null);
  assert.equal(parseCuaDriverPermissionsStatus("{}"), null);
});

test("parseCuaDriverPermissionsStatusDetail identifies a stopped driver daemon", () => {
  assert.deepEqual(
    parseCuaDriverPermissionsStatusDetail(
      JSON.stringify({
        daemon_running: false,
        reason:
          "no CuaDriver daemon is running under the driver's own identity (com.trycua.driver), so its real TCC status can't be read from this process. Run `cua-driver permissions grant` to grant + verify.",
        status: "unknown"
      })
    ),
    {
      permissions: null,
      reason: "driver-daemon-not-running",
      diagnosticMessage:
        "no CuaDriver daemon is running under the driver's own identity (com.trycua.driver), so its real TCC status can't be read from this process. Run `cua-driver permissions grant` to grant + verify."
    }
  );
});

test("parseCuaDriverPermissionsStatusDetail preserves partial permission state", () => {
  assert.deepEqual(
    parseCuaDriverPermissionsStatusDetail(
      JSON.stringify({
        accessibility: true,
        screen_recording: false,
        screen_recording_capturable: false,
        source: {
          attribution: "driver-daemon"
        }
      })
    ),
    {
      permissions: {
        accessibility: true,
        screenRecording: false,
        screenRecordingCapturable: false,
        source: "driver-daemon"
      }
    }
  );
});

test("CuaDriver 0.20 unprobed capture status remains ready after TCC grants", () => {
  assert.deepEqual(
    resolveCuaDriverAuthorizationStatus({
      accessibility: true,
      screenRecording: true,
      screenRecordingCapturable: null,
      source: "driver-daemon"
    }),
    { authorization: "authorized" }
  );
});

test("an explicit failed capture probe still requires authorization", () => {
  assert.deepEqual(
    resolveCuaDriverAuthorizationStatus({
      accessibility: true,
      screenRecording: true,
      screenRecordingCapturable: false,
      source: "driver-daemon"
    }),
    {
      authorization: "needs-authorization",
      reason: "screen-recording-not-capturable"
    }
  );
});
