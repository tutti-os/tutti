import assert from "node:assert/strict";
import test from "node:test";
import {
  parseCuaDriverPermissionsStatus,
  parseCuaDriverPermissionsStatusDetail
} from "./computerUsePermissions.ts";

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
