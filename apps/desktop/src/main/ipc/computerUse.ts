import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { delimiter, join } from "node:path";
import {
  desktopIpcChannels,
  type DesktopComputerUseActionResult,
  type DesktopComputerUseActionFailureReason,
  type DesktopComputerUseAuthorizationState,
  type DesktopComputerUsePermissionGrantStatus,
  type DesktopComputerUsePermissionPane,
  type DesktopComputerUsePermissionsStatus,
  type DesktopComputerUseRestartDriverInput,
  type DesktopComputerUseRestartDriverResult,
  type DesktopComputerUseStatus,
  type DesktopComputerUseStatusReason,
  type DesktopComputerUsePlatform
} from "../../shared/contracts/ipc.ts";
import { shell } from "electron";
import { registerDesktopIpcHandler } from "./handle.ts";
import {
  parseCuaDriverDoctorStatus,
  parseCuaDriverPermissionsStatusDetail
} from "./computerUsePermissions.ts";
import {
  buildWindowsCuaDriverCommand,
  CUA_DRIVER_WINDOWS_VERSION
} from "./computerUseWindows.ts";
import { getDesktopLogger } from "../logging.ts";

const CUA_DRIVER_INSTALL_SCRIPT_URL =
  "https://raw.githubusercontent.com/trycua/cua/main/libs/cua-driver/scripts/install.sh";
const CUA_DRIVER_UNINSTALL_SCRIPT_URL =
  "https://raw.githubusercontent.com/trycua/cua/main/libs/cua-driver/scripts/uninstall.sh";
const CUA_DRIVER_WINDOWS_INSTALL_SCRIPT_URL =
  "https://cua.ai/driver/install.ps1";
const CUA_DRIVER_WINDOWS_UNINSTALL_SCRIPT_URL =
  "https://cua.ai/driver/uninstall.ps1";
const CUA_DRIVER_APP_BINARY_PATH =
  "/Applications/CuaDriver.app/Contents/MacOS/cua-driver";
const COMPUTER_USE_GRANT_TIMEOUT_MS = 75_000;
const COMPUTER_USE_GRANT_TIMEOUT_OUTPUT =
  "Timed out waiting for macOS permission confirmation. Open System Settings > Privacy & Security and enable CuaDriver permissions, then check again.";
const COMPUTER_USE_DRIVER_STOP_TIMEOUT_MS = 10_000;
const COMPUTER_USE_WINDOWS_DRIVER_SCRIPT_TIMEOUT_MS = 300_000;
const COMPUTER_USE_WINDOWS_DOCTOR_TIMEOUT_MS = 10_000;
// Relaunching the daemon never prompts — TCC prompts belong exclusively to
// the grant flow — so the restart only needs to wait for the app to come up.
const COMPUTER_USE_DRIVER_LAUNCH_TIMEOUT_MS = 10_000;
const COMPUTER_USE_DRIVER_LAUNCH_POLL_INTERVAL_MS = 500;
const CUA_DRIVER_APP_BUNDLE_PATH = "/Applications/CuaDriver.app";
const COMPUTER_USE_PERMISSION_SETTINGS_URLS: Record<
  DesktopComputerUsePermissionPane,
  string
> = {
  accessibility:
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  "screen-recording":
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  privacy: "x-apple.systempreferences:com.apple.preference.security"
};
const COMPUTER_USE_GRANT_ACTION_ID = "computer-use-permission-grant" as const;
const COMPUTER_USE_DIAGNOSTIC_MESSAGE_MAX_LENGTH = 600;

interface ComputerUseGrantActionState {
  id: typeof COMPUTER_USE_GRANT_ACTION_ID;
  startedAtUnixMs: number;
  promise: Promise<DesktopComputerUseActionResult>;
  result: DesktopComputerUseActionResult | null;
}

let computerUseGrantActionState: ComputerUseGrantActionState | null = null;
let computerUseRestartPromise: Promise<DesktopComputerUseRestartDriverResult> | null =
  null;
let computerUseInstallPromise: Promise<DesktopComputerUseActionResult> | null =
  null;
let checkStatusInFlight: Promise<DesktopComputerUseStatus> | null = null;
let lastComputerUseStatusLogSignature: string | null = null;

function cuaDriverExecutableCandidates(): string[] {
  const candidates = [
    process.env.TUTTI_COMPUTER_MCP_ENTRY_PATH,
    process.env.HOME ? `${process.env.HOME}/.local/bin/cua-driver` : null,
    "/usr/local/bin/cua-driver",
    "/opt/homebrew/bin/cua-driver",
    CUA_DRIVER_APP_BINARY_PATH,
    ...windowsCuaDriverExecutableCandidates()
  ];
  return candidates
    .map((candidate) => candidate?.trim() ?? "")
    .filter((candidate) => candidate.length > 0);
}

function windowsCuaDriverExecutableCandidates(): string[] {
  if (process.platform !== "win32") {
    return [];
  }
  const localAppData = process.env.LOCALAPPDATA?.trim();
  const userProfile = process.env.USERPROFILE?.trim();
  return [
    localAppData
      ? join(
          localAppData,
          "Programs",
          "Cua",
          "cua-driver",
          "bin",
          "cua-driver.exe"
        )
      : null,
    localAppData
      ? join(localAppData, "Programs", "Cua", "cua-driver.exe")
      : null,
    localAppData ? join(localAppData, "cua-driver", "cua-driver.exe") : null,
    userProfile ? join(userProfile, ".local", "bin", "cua-driver.exe") : null,
    userProfile
      ? join(
          userProfile,
          ".cua-driver",
          "packages",
          "current",
          "cua-driver.exe"
        )
      : null
  ].filter((candidate): candidate is string => candidate !== null);
}

function resolveCuaDriverExecutable(): string | null {
  for (const candidate of cuaDriverExecutableCandidates()) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function isCuaDriverInstalled(): boolean {
  if (process.platform !== "darwin" && process.platform !== "win32") {
    return false;
  }
  if (
    process.platform === "darwin" &&
    existsSync("/Applications/CuaDriver.app")
  ) {
    return true;
  }
  return resolveCuaDriverExecutable() !== null;
}

function runSubprocess(
  command: string,
  args: string[],
  options: { timeoutMs?: number; timeoutOutput?: string } = {}
): Promise<DesktopComputerUseActionResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const localBinPath = process.env.HOME
      ? `${process.env.HOME}/.local/bin${delimiter}`
      : "";
    let settled = false;
    let timedOut = false;
    let exitCode: number | null = null;
    let failureReason: DesktopComputerUseActionFailureReason | undefined;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let forceKillTimeout: ReturnType<typeof setTimeout> | null = null;

    const finish = (result: DesktopComputerUseActionResult) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      if (forceKillTimeout) {
        clearTimeout(forceKillTimeout);
      }
      resolve(result);
    };

    const buildOutput = () => {
      const output = Buffer.concat(chunks).toString("utf8");
      if (!timedOut) {
        return output;
      }
      return `${output}${output.endsWith("\n") || output.length === 0 ? "" : "\n"}${options.timeoutOutput ?? "Command timed out."}`;
    };

    const child = spawn(command, args, {
      env: {
        ...process.env,
        // Ensure ~/.local/bin is on PATH for cua-driver lookups
        PATH: `${localBinPath}${process.env.PATH ?? ""}`
      },
      stdio: ["ignore", "pipe", "pipe"]
    });

    if (options.timeoutMs && options.timeoutMs > 0) {
      timeout = setTimeout(() => {
        timedOut = true;
        failureReason = "timeout";
        child.kill("SIGTERM");
        forceKillTimeout = setTimeout(() => {
          child.kill("SIGKILL");
          finish({
            success: false,
            output: buildOutput(),
            exitCode,
            failureReason
          });
        }, 3_000);
      }, options.timeoutMs);
    }

    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => chunks.push(chunk));

    child.on("close", (code) => {
      exitCode = typeof code === "number" ? code : null;
      if (!timedOut && exitCode !== 0) {
        failureReason = "exit-code";
      }
      finish({
        success: !timedOut && code === 0,
        output: buildOutput(),
        exitCode,
        ...(failureReason ? { failureReason } : {})
      });
    });

    child.on("error", (err) => {
      failureReason = "spawn-error";
      finish({
        success: false,
        output: err.message,
        exitCode,
        failureReason
      });
    });
  });
}

type CuaDriverAction = "install" | "uninstall";

function logCuaDriverActionCompleted(
  action: CuaDriverAction,
  startedAtUnixMs: number,
  result: DesktopComputerUseActionResult
): void {
  const logger = getDesktopLogger();
  const log = result.success
    ? logger.info.bind(logger)
    : logger.warn.bind(logger);
  log(`computer use driver ${action} completed`, {
    operation: action,
    success: result.success,
    elapsedMs: Date.now() - startedAtUnixMs,
    exitCode: result.exitCode ?? null,
    failureReason: result.failureReason ?? null,
    outputBytes: result.output.length,
    diagnosticMessage: result.output
      ? truncateComputerUseDiagnosticMessage(result.output)
      : null
  });
}

function runLoggedCuaDriverCommand(
  action: CuaDriverAction,
  command: string,
  args: string[],
  options: {
    timeoutMs?: number;
    timeoutOutput?: string;
    logFields?: Record<string, unknown>;
  } = {}
): Promise<DesktopComputerUseActionResult> {
  const startedAtUnixMs = Date.now();
  getDesktopLogger().info(`computer use driver ${action} started`, {
    operation: action,
    command,
    timeoutMs: options.timeoutMs ?? null,
    ...options.logFields
  });
  return runSubprocess(command, args, options).then((result) => {
    logCuaDriverActionCompleted(action, startedAtUnixMs, result);
    return result;
  });
}

function ensureCuaDriverPermissionGrantAction(): ComputerUseGrantActionState {
  if (computerUseGrantActionState?.result === null) {
    getDesktopLogger().info("computer use permission grant reused");
    return computerUseGrantActionState;
  }

  const executable = resolveCuaDriverExecutable() ?? "cua-driver";
  const startedAtUnixMs = Date.now();
  getDesktopLogger().info("computer use permission grant started", {
    executable,
    timeoutMs: COMPUTER_USE_GRANT_TIMEOUT_MS
  });
  const state: ComputerUseGrantActionState = {
    id: COMPUTER_USE_GRANT_ACTION_ID,
    startedAtUnixMs,
    promise: runSubprocess(executable, ["permissions", "grant"], {
      timeoutMs: COMPUTER_USE_GRANT_TIMEOUT_MS,
      timeoutOutput: COMPUTER_USE_GRANT_TIMEOUT_OUTPUT
    }),
    result: null
  };
  state.promise = state.promise.then((result) => {
    state.result = result;
    const elapsedMs = Date.now() - startedAtUnixMs;
    const timedOut = result.failureReason === "timeout";
    const logFields = {
      success: result.success,
      elapsedMs,
      timedOut
    };
    if (result.success) {
      getDesktopLogger().info(
        "computer use permission grant completed",
        logFields
      );
    } else {
      getDesktopLogger().warn(
        "computer use permission grant completed",
        logFields
      );
    }
    return result;
  });
  computerUseGrantActionState = state;
  return state;
}

async function ensureCuaDriverPermissionGrantActionLaunched(): Promise<ComputerUseGrantActionState> {
  if (computerUseGrantActionState?.result === null) {
    return computerUseGrantActionState;
  }
  const status = await checkCuaDriverStatusCoalesced();
  if (status.installed && status.permissions === null) {
    // The daemon is not answering, so the grant would wait blind for up to
    // its full timeout. Bring the daemon up via the fast no-prompt path
    // first (~500ms) so permission rows read live state while the grant
    // waits on TCC. A launch failure is not fatal — the grant's own
    // LaunchServices start is the fallback.
    await restartCuaDriver();
  }
  return ensureCuaDriverPermissionGrantAction();
}

async function startCuaDriverPermissionGrant(): Promise<DesktopComputerUsePermissionGrantStatus> {
  if (process.platform === "win32") {
    return {
      id: COMPUTER_USE_GRANT_ACTION_ID,
      running: false,
      startedAtUnixMs: Date.now(),
      elapsedMs: 0,
      result: {
        success: false,
        output:
          "Windows computer use uses cua-driver doctor readiness; macOS permission grant is not applicable."
      }
    };
  }
  return computerUseGrantActionSnapshot(
    await ensureCuaDriverPermissionGrantActionLaunched()
  );
}

function getCuaDriverPermissionGrantStatus(): DesktopComputerUsePermissionGrantStatus | null {
  return computerUseGrantActionState
    ? computerUseGrantActionSnapshot(computerUseGrantActionState)
    : null;
}

function computerUseGrantActionSnapshot(
  state: ComputerUseGrantActionState
): DesktopComputerUsePermissionGrantStatus {
  return {
    id: state.id,
    running: state.result === null,
    startedAtUnixMs: state.startedAtUnixMs,
    elapsedMs: Date.now() - state.startedAtUnixMs,
    ...(state.result ? { result: state.result } : {})
  };
}

function summarizeComputerUseStatusForLog(
  status: DesktopComputerUseStatus
): Record<string, unknown> {
  return {
    platform: status.platform ?? "unknown",
    authorization: status.authorization,
    installed: status.installed,
    permissionAccessibility: status.permissions?.accessibility ?? null,
    permissionScreenRecording: status.permissions?.screenRecording ?? null,
    permissionScreenRecordingCapturable:
      status.permissions?.screenRecordingCapturable ?? null,
    permissionSource: status.permissions?.source ?? null,
    reason: status.reason ?? null,
    ...(status.diagnosticMessage
      ? {
          diagnosticMessage: truncateComputerUseDiagnosticMessage(
            status.diagnosticMessage
          )
        }
      : {})
  };
}

function logComputerUseStatusChecked(
  status: DesktopComputerUseStatus,
  level: "info" | "warn",
  fields: Record<string, unknown>
): void {
  const statusFields = summarizeComputerUseStatusForLog(status);
  const signature = [
    status.platform ?? "unknown",
    status.installed ? "installed" : "not-installed",
    status.authorization,
    status.reason ?? "",
    status.permissions?.accessibility ?? "",
    status.permissions?.screenRecording ?? "",
    status.permissions?.screenRecordingCapturable ?? "",
    status.permissions?.source ?? ""
  ].join(":");
  const logger = getDesktopLogger();
  const log =
    signature === lastComputerUseStatusLogSignature
      ? logger.debug.bind(logger)
      : level === "warn"
        ? logger.warn.bind(logger)
        : logger.info.bind(logger);
  lastComputerUseStatusLogSignature = signature;
  log("computer use permission status checked", {
    ...statusFields,
    ...fields
  });
}

function truncateComputerUseDiagnosticMessage(message: string): string {
  if (message.length <= COMPUTER_USE_DIAGNOSTIC_MESSAGE_MAX_LENGTH) {
    return message;
  }
  return `${message.slice(0, COMPUTER_USE_DIAGNOSTIC_MESSAGE_MAX_LENGTH)}…`;
}

async function grantCuaDriverPermissions(): Promise<DesktopComputerUseActionResult> {
  if (process.platform === "win32") {
    return {
      success: false,
      output:
        "Windows computer use uses cua-driver doctor readiness; macOS permission grant is not applicable."
    };
  }
  const action = await ensureCuaDriverPermissionGrantActionLaunched();
  return action.promise;
}

async function openComputerUsePermissionSettings(
  pane: DesktopComputerUsePermissionPane
): Promise<void> {
  if (process.platform === "win32") {
    throw new Error(
      "Windows computer use has no macOS permission settings pane; check cua-driver readiness instead."
    );
  }
  const url = COMPUTER_USE_PERMISSION_SETTINGS_URLS[pane];
  getDesktopLogger().info("computer use permission settings opened", {
    pane
  });
  await shell.openExternal(url);
}

function resolveComputerUseStatus(input: {
  installed: boolean;
  platform?: DesktopComputerUsePlatform;
  permissions: DesktopComputerUsePermissionsStatus | null;
  authorization?: DesktopComputerUseAuthorizationState;
  reason?: DesktopComputerUseStatusReason;
  diagnosticMessage?: string;
}): DesktopComputerUseStatus {
  if (!input.installed) {
    return {
      installed: false,
      platform: input.platform ?? computerUsePlatform(),
      permissions: null,
      authorization: input.authorization ?? "unknown",
      reason: "not-installed"
    };
  }

  const permissions = input.permissions;
  if (!permissions) {
    return {
      installed: true,
      platform: input.platform ?? computerUsePlatform(),
      permissions: null,
      authorization: input.authorization ?? "unknown",
      reason: input.reason ?? "status-unparseable",
      ...(input.diagnosticMessage
        ? { diagnosticMessage: input.diagnosticMessage }
        : {})
    };
  }

  const status = resolveComputerUseAuthorizationStatus(permissions);
  return {
    installed: true,
    platform: input.platform ?? computerUsePlatform(),
    permissions,
    authorization: status.authorization,
    ...(status.reason ? { reason: status.reason } : {}),
    ...(input.diagnosticMessage
      ? { diagnosticMessage: input.diagnosticMessage }
      : {})
  };
}

function computerUsePlatform(): DesktopComputerUsePlatform {
  if (process.platform === "darwin" || process.platform === "win32") {
    return process.platform;
  }
  return "unknown";
}

function resolveComputerUseAuthorizationStatus(
  permissions: DesktopComputerUsePermissionsStatus
): {
  authorization: DesktopComputerUseStatus["authorization"];
  reason?: DesktopComputerUseStatusReason;
} {
  if (
    permissions.accessibility === true &&
    permissions.screenRecording === true &&
    permissions.screenRecordingCapturable === true
  ) {
    return { authorization: "authorized" };
  }
  if (
    permissions.screenRecording === true &&
    permissions.screenRecordingCapturable !== true
  ) {
    return {
      authorization: "needs-authorization",
      reason: "screen-recording-not-capturable"
    };
  }
  if (
    permissions.accessibility === false ||
    permissions.screenRecording === false
  ) {
    return {
      authorization: "needs-authorization",
      reason: "permission-missing"
    };
  }
  return { authorization: "unknown", reason: "status-unparseable" };
}

async function checkWindowsCuaDriverStatus(
  executable: string,
  startedAtUnixMs: number
): Promise<DesktopComputerUseStatus> {
  const commandStartedAtUnixMs = Date.now();
  const doctorResult = await runSubprocess(executable, ["doctor", "--json"], {
    timeoutMs: COMPUTER_USE_WINDOWS_DOCTOR_TIMEOUT_MS,
    timeoutOutput: "Windows cua-driver doctor timed out."
  });
  getDesktopLogger().debug("computer use driver doctor command completed", {
    elapsedMs: Date.now() - commandStartedAtUnixMs,
    outputBytes: doctorResult.output.length,
    success: doctorResult.success
  });

  const doctor = parseCuaDriverDoctorStatus(doctorResult.output);
  if (doctor?.degraded) {
    const status = resolveComputerUseStatus({
      installed: true,
      platform: "win32",
      permissions: null,
      authorization: "authorized",
      reason: "driver-doctor-failed",
      diagnosticMessage: doctor.diagnosticMessage ?? doctorResult.output
    });
    logComputerUseStatusChecked(status, "warn", {
      elapsedMs: Date.now() - startedAtUnixMs
    });
    return status;
  }

  if (!doctorResult.success) {
    const status = resolveComputerUseStatus({
      installed: true,
      platform: "win32",
      permissions: null,
      reason: "driver-doctor-failed",
      diagnosticMessage: doctorResult.output
    });
    logComputerUseStatusChecked(status, "warn", {
      elapsedMs: Date.now() - startedAtUnixMs
    });
    return status;
  }

  if (!doctor || !doctor.ok) {
    const status = resolveComputerUseStatus({
      installed: true,
      platform: "win32",
      permissions: null,
      reason: "driver-doctor-failed",
      diagnosticMessage: doctor?.diagnosticMessage ?? doctorResult.output
    });
    logComputerUseStatusChecked(status, "warn", {
      elapsedMs: Date.now() - startedAtUnixMs
    });
    return status;
  }

  // Windows exposes UI Automation and native input readiness through doctor,
  // rather than macOS TCC permission fields. Keep permissions null and use the
  // authorization state as the cross-platform readiness contract.
  const status = resolveComputerUseStatus({
    installed: true,
    platform: "win32",
    permissions: null,
    authorization: "authorized"
  });
  logComputerUseStatusChecked(status, "info", {
    elapsedMs: Date.now() - startedAtUnixMs
  });
  return status;
}

async function checkCuaDriverStatus(): Promise<DesktopComputerUseStatus> {
  const startedAtUnixMs = Date.now();
  const installed = isCuaDriverInstalled();
  if (!installed) {
    const status = resolveComputerUseStatus({
      installed: false,
      permissions: null
    });
    logComputerUseStatusChecked(status, "info", {
      elapsedMs: Date.now() - startedAtUnixMs
    });
    return status;
  }

  const executable = resolveCuaDriverExecutable();
  if (!executable) {
    const status = resolveComputerUseStatus({
      installed: true,
      permissions: null,
      reason: "status-command-failed",
      diagnosticMessage: "cua-driver executable was not found."
    });
    logComputerUseStatusChecked(status, "warn", {
      elapsedMs: Date.now() - startedAtUnixMs,
      executablePresent: false
    });
    return status;
  }

  if (process.platform === "win32") {
    return checkWindowsCuaDriverStatus(executable, startedAtUnixMs);
  }

  getDesktopLogger().debug("computer use permission status command started", {
    executable
  });
  const commandStartedAtUnixMs = Date.now();
  const permissionsResult = await runSubprocess(executable, [
    "permissions",
    "status",
    "--json"
  ]);
  getDesktopLogger().debug("computer use permission status command completed", {
    elapsedMs: Date.now() - commandStartedAtUnixMs,
    outputBytes: permissionsResult.output.length,
    success: permissionsResult.success
  });
  if (!permissionsResult.success) {
    const status = resolveComputerUseStatus({
      installed: true,
      permissions: null,
      reason: "status-command-failed",
      diagnosticMessage: permissionsResult.output
    });
    logComputerUseStatusChecked(status, "warn", {
      elapsedMs: Date.now() - startedAtUnixMs
    });
    return status;
  }

  const detail = parseCuaDriverPermissionsStatusDetail(
    permissionsResult.output
  );
  const status = resolveComputerUseStatus({
    installed: true,
    permissions: detail.permissions,
    reason: detail.reason,
    diagnosticMessage: detail.diagnosticMessage
  });
  const logFields = {
    elapsedMs: Date.now() - startedAtUnixMs
  };
  logComputerUseStatusChecked(
    status,
    status.authorization === "authorized" ? "info" : "warn",
    logFields
  );
  return status;
}

function checkCuaDriverStatusCoalesced(): Promise<DesktopComputerUseStatus> {
  if (checkStatusInFlight) {
    return checkStatusInFlight;
  }
  checkStatusInFlight = checkCuaDriverStatus().finally(() => {
    checkStatusInFlight = null;
  });
  return checkStatusInFlight;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function performCuaDriverRestart(
  input?: DesktopComputerUseRestartDriverInput
): Promise<DesktopComputerUseRestartDriverResult> {
  if (process.platform === "win32") {
    const status = await checkCuaDriverStatusCoalesced();
    const result: DesktopComputerUseActionResult = {
      success: status.installed && status.authorization === "authorized",
      output:
        status.installed && status.authorization === "authorized"
          ? "Windows cua-driver readiness is managed by doctor; Tutti starts its daemon when an MCP session is opened."
          : status.diagnosticMessage ||
            "Windows cua-driver is not ready; install the driver and check again."
    };
    return { result, status };
  }
  const startedAtUnixMs = Date.now();
  const grantAction = computerUseGrantActionState;
  if (grantAction?.result === null && input?.force !== true) {
    // A grant is mid-flight; stopping the daemon underneath it would break
    // the pending TCC confirmation. Return immediately — awaiting the grant
    // here would hang the restart for the grant's full user-paced timeout.
    // Forced restarts (the wizard's explicit re-check) proceed anyway: the
    // user has finished granting and asked for reconciliation.
    getDesktopLogger().info(
      "computer use driver restart skipped for running grant"
    );
    return {
      result: {
        success: false,
        output:
          "Permission grant is still confirming; the driver was not restarted."
      },
      status: await checkCuaDriverStatusCoalesced()
    };
  }

  // Relaunch must go through the app bundle so the daemon keeps its own TCC
  // identity (com.trycua.driver). It must NOT use `permissions grant` — that
  // waits on TCC confirmation and would hang the restart on a fresh install;
  // prompting stays exclusive to the grant flow.
  if (!existsSync(CUA_DRIVER_APP_BUNDLE_PATH)) {
    return {
      result: {
        success: false,
        output: "CuaDriver.app was not found. Reinstall computer use."
      },
      status: await checkCuaDriverStatusCoalesced()
    };
  }

  getDesktopLogger().info("computer use driver restart started");
  const executable = resolveCuaDriverExecutable();
  if (executable) {
    // A stop failure usually just means the daemon was not running; the
    // relaunch below is what matters either way.
    await runSubprocess(executable, ["stop"], {
      timeoutMs: COMPUTER_USE_DRIVER_STOP_TIMEOUT_MS
    });
  }
  // The bundle wraps the CLI binary; without `serve` it prints usage and
  // exits instead of starting the daemon. `--no-permissions-gate` keeps the
  // fresh daemon from auto-opening System Settings / raising TCC prompts
  // when permissions are missing — this restart is a silent reconciliation,
  // and prompting belongs exclusively to user-initiated actions.
  const launchResult = await runSubprocess(
    "/usr/bin/open",
    [
      "-g",
      "-a",
      CUA_DRIVER_APP_BUNDLE_PATH,
      "--args",
      "serve",
      "--no-permissions-gate"
    ],
    { timeoutMs: COMPUTER_USE_DRIVER_LAUNCH_TIMEOUT_MS }
  );

  let status = await checkCuaDriverStatusCoalesced();
  while (
    launchResult.success &&
    status.permissions === null &&
    Date.now() - startedAtUnixMs < COMPUTER_USE_DRIVER_LAUNCH_TIMEOUT_MS
  ) {
    await sleep(COMPUTER_USE_DRIVER_LAUNCH_POLL_INTERVAL_MS);
    status = await checkCuaDriverStatusCoalesced();
  }

  const daemonUp = status.permissions !== null;
  const result: DesktopComputerUseActionResult = {
    success: launchResult.success && daemonUp,
    output: daemonUp
      ? launchResult.output
      : launchResult.output ||
        "CuaDriver did not report its status after relaunch."
  };
  const logFields = {
    success: result.success,
    elapsedMs: Date.now() - startedAtUnixMs,
    ...summarizeComputerUseStatusForLog(status)
  };
  if (result.success) {
    getDesktopLogger().info("computer use driver restart completed", logFields);
  } else {
    getDesktopLogger().warn("computer use driver restart completed", logFields);
  }
  return { result, status };
}

function restartCuaDriver(
  input?: DesktopComputerUseRestartDriverInput
): Promise<DesktopComputerUseRestartDriverResult> {
  if (computerUseRestartPromise) {
    return computerUseRestartPromise;
  }
  computerUseRestartPromise = performCuaDriverRestart(input).finally(() => {
    computerUseRestartPromise = null;
  });
  return computerUseRestartPromise;
}

function runWindowsCuaDriverScript(
  action: CuaDriverAction,
  url: string
): Promise<DesktopComputerUseActionResult> {
  const command = buildWindowsCuaDriverCommand(action, url);
  return runLoggedCuaDriverCommand(action, command.command, command.args, {
    timeoutMs: COMPUTER_USE_WINDOWS_DRIVER_SCRIPT_TIMEOUT_MS,
    timeoutOutput: "Windows driver script timed out.",
    logFields: {
      scriptUrl: url,
      driverVersion: CUA_DRIVER_WINDOWS_VERSION
    }
  });
}

function installCuaDriver(): Promise<DesktopComputerUseActionResult> {
  if (computerUseInstallPromise) {
    getDesktopLogger().info("computer use driver install reused");
    return computerUseInstallPromise;
  }
  computerUseInstallPromise = performCuaDriverInstall().finally(() => {
    computerUseInstallPromise = null;
  });
  return computerUseInstallPromise;
}

function performCuaDriverInstall(): Promise<DesktopComputerUseActionResult> {
  if (process.platform === "win32") {
    return runWindowsCuaDriverScript(
      "install",
      CUA_DRIVER_WINDOWS_INSTALL_SCRIPT_URL
    );
  }
  return runLoggedCuaDriverCommand("install", "/bin/bash", [
    "-c",
    `curl -fsSL ${CUA_DRIVER_INSTALL_SCRIPT_URL} | bash`
  ]);
}

function uninstallCuaDriver(): Promise<DesktopComputerUseActionResult> {
  if (process.platform === "win32") {
    return runWindowsCuaDriverScript(
      "uninstall",
      CUA_DRIVER_WINDOWS_UNINSTALL_SCRIPT_URL
    );
  }
  return runLoggedCuaDriverCommand("uninstall", "/bin/bash", [
    "-c",
    `curl -fsSL ${CUA_DRIVER_UNINSTALL_SCRIPT_URL} | bash`
  ]);
}

export function registerComputerUseIpc(): void {
  registerDesktopIpcHandler(desktopIpcChannels.computerUse.checkStatus, () =>
    checkCuaDriverStatusCoalesced()
  );

  registerDesktopIpcHandler(desktopIpcChannels.computerUse.install, () =>
    installCuaDriver()
  );

  registerDesktopIpcHandler(desktopIpcChannels.computerUse.uninstall, () =>
    uninstallCuaDriver()
  );

  registerDesktopIpcHandler(
    desktopIpcChannels.computerUse.grantPermissions,
    () => grantCuaDriverPermissions()
  );

  registerDesktopIpcHandler(
    desktopIpcChannels.computerUse.startPermissionGrant,
    () => startCuaDriverPermissionGrant()
  );

  registerDesktopIpcHandler(
    desktopIpcChannels.computerUse.getPermissionGrantStatus,
    () => getCuaDriverPermissionGrantStatus()
  );

  registerDesktopIpcHandler(
    desktopIpcChannels.computerUse.openPermissionSettings,
    (_event, pane) => openComputerUsePermissionSettings(pane)
  );

  registerDesktopIpcHandler(
    desktopIpcChannels.computerUse.restartDriver,
    (_event, input) => restartCuaDriver(input)
  );
}
