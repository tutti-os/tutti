import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  parseCuaDriverPermissionsStatus,
  parseCuaDriverPermissionsStatusDetail
} from "./computerUsePermissions.ts";

const computerUseSource = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "computerUse.ts"),
  "utf8"
);

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

test("computer use status checks emit diagnostic logs", () => {
  assert.match(
    computerUseSource,
    /computer use permission status command started/
  );
  assert.match(
    computerUseSource,
    /computer use permission status command completed/
  );
  assert.match(computerUseSource, /computer use permission status checked/);
  assert.match(computerUseSource, /summarizeComputerUseStatusForLog/);
});

test("computer use status checks coalesce concurrent subprocess spawns", () => {
  assert.match(computerUseSource, /checkStatusInFlight/);
  assert.match(
    computerUseSource,
    /desktopIpcChannels\.computerUse\.checkStatus,\s*\(\)\s*=>\s*checkCuaDriverStatusCoalesced\(\)/
  );
});

test("computer use restart driver stops then relaunches the app bundle without prompting", () => {
  assert.match(
    computerUseSource,
    /desktopIpcChannels\.computerUse\.restartDriver/
  );
  const restartStart = computerUseSource.indexOf(
    "async function performCuaDriverRestart"
  );
  const restartEnd = computerUseSource.indexOf(
    "function restartCuaDriver",
    restartStart
  );
  assert.ok(restartStart >= 0);
  const restartSource = computerUseSource.slice(restartStart, restartEnd);
  const stopIndex = restartSource.indexOf('["stop"]');
  const relaunchIndex = restartSource.indexOf('"--no-permissions-gate"');
  assert.ok(stopIndex >= 0, "restart path stops the daemon");
  assert.ok(relaunchIndex > stopIndex, "restart relaunches after stopping");
  // TCC prompts belong exclusively to the grant flow; a restart on a fresh
  // install must never hang waiting for permission confirmation.
  assert.ok(!restartSource.includes('"permissions", "grant"'));
});

test("computer use restart driver is single-flight and skips a running grant", () => {
  assert.match(computerUseSource, /computerUseRestartPromise/);
  assert.match(
    computerUseSource,
    /if \(grantAction\?\.result === null && input\?\.force !== true\) \{/
  );
  // Awaiting the user-paced grant here would hang the restart for up to the
  // grant timeout; the restart must return immediately instead. Forced
  // restarts (the wizard's explicit re-check) proceed regardless.
  assert.doesNotMatch(computerUseSource, /await grantAction\.promise/);
  assert.match(
    computerUseSource,
    /computer use driver restart skipped for running grant/
  );
});

test("computer use grant pre-launches the daemon so status stays readable", () => {
  const launchedStart = computerUseSource.indexOf(
    "async function ensureCuaDriverPermissionGrantActionLaunched"
  );
  assert.ok(launchedStart >= 0);
  const launchedEnd = computerUseSource.indexOf(
    "async function startCuaDriverPermissionGrant",
    launchedStart
  );
  const launchedSource = computerUseSource.slice(launchedStart, launchedEnd);
  assert.match(launchedSource, /checkCuaDriverStatusCoalesced\(\)/);
  assert.match(
    launchedSource,
    /status\.installed && status\.permissions === null/
  );
  assert.match(launchedSource, /await restartCuaDriver\(\)/);
  // Both grant entry points must go through the pre-launch wrapper.
  assert.match(
    computerUseSource,
    /return computerUseGrantActionSnapshot\(\s*await ensureCuaDriverPermissionGrantActionLaunched\(\)\s*\);/
  );
  assert.match(
    computerUseSource,
    /const action = await ensureCuaDriverPermissionGrantActionLaunched\(\);\s*return action\.promise;/
  );
});
