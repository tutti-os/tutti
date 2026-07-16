import { readFile, rm } from "node:fs/promises";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import type {
  HealthStatusResponse,
  TuttidClient
} from "@tutti-os/client-tuttid-ts";
import { resolveDesktopDefaultsFromEnv, resolveTuttiEnv } from "../defaults.ts";
import {
  desktopErrorCodes,
  formatErrorMessage
} from "../../shared/errors/desktopErrors.ts";
import { getDesktopLogger, getDesktopLogSessionID } from "../logging.ts";
import {
  resolveDesktopLogsDir,
  type DesktopDaemonEndpoint
} from "../transport/paths.ts";
import { applyUserShellProxyToSession } from "../net/sessionProxy.ts";
import { resolveCachedUserShellEnv } from "./userShellEnv.ts";
import {
  createDaemonRestartController,
  type DaemonRestartController
} from "./daemonRestartController.ts";

const healthPollIntervalMs = 250;
const healthTimeoutMs = 90_000;
const shutdownTimeoutMs = 90_000;
const staleProcessShutdownTimeoutMs = 3_000;

const require = createRequire(import.meta.url);

export interface TuttidManager {
  getHealth(): Promise<HealthStatusResponse>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

interface LaunchSpec {
  command: string;
  args: string[];
  cwd?: string;
}

interface DesktopElectronAppRuntime {
  isPackaged: boolean;
  resourcesPath: string;
}

interface ResolveLaunchSpecOptions {
  repoRoot?: string;
}

export function createTuttidManager(
  endpoint: DesktopDaemonEndpoint,
  tuttidClient: TuttidClient
): TuttidManager {
  return new ManagedTuttid(endpoint, tuttidClient);
}

class ManagedTuttid implements TuttidManager {
  private process: ChildProcess | null = null;
  private stopRequested = false;
  private readonly endpoint: DesktopDaemonEndpoint;
  private readonly tuttidClient: TuttidClient;
  private readonly restartController: DaemonRestartController;

  constructor(endpoint: DesktopDaemonEndpoint, tuttidClient: TuttidClient) {
    this.endpoint = endpoint;
    this.tuttidClient = tuttidClient;
    this.restartController = createDaemonRestartController({
      restart: () => this.start(),
      isStopRequested: () => this.stopRequested,
      delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: () => Date.now(),
      logger: {
        info: (message, fields) => getDesktopLogger().info(message, fields),
        warn: (message, fields) => getDesktopLogger().warn(message, fields),
        error: (message, fields) => getDesktopLogger().error(message, fields)
      }
    });
  }

  getHealth(): Promise<HealthStatusResponse> {
    return this.tuttidClient.getHealth();
  }

  async start(): Promise<void> {
    if (this.process) {
      return;
    }

    this.endpoint.boundAddr = null;
    await stopStaleTuttid(this.endpoint.pidPath);
    await clearListenerInfo(this.endpoint.listenerInfoPath);

    const launchSpec = resolveLaunchSpec();
    const logOutput = resolveDaemonLogOutput();
    const forwardStdout = shouldForwardDaemonStdout(logOutput);
    const logger = getDesktopLogger();
    const userShellEnv = await resolveManagedDaemonUserShellEnv();
    void applyUserShellProxyToSession(userShellEnv);
    logger.info("starting managed tuttid", {
      command: launchSpec.command,
      args: launchSpec.args,
      cwd: launchSpec.cwd ?? process.cwd(),
      listener_info_path: this.endpoint.listenerInfoPath,
      pid_path: this.endpoint.pidPath,
      log_output: logOutput
    });

    const child = spawn(launchSpec.command, launchSpec.args, {
      cwd: launchSpec.cwd,
      detached: process.platform !== "win32",
      env: resolveManagedDaemonProcessEnv({
        endpoint: this.endpoint,
        logOutput,
        userShellEnv
      }),
      stdio: ["ignore", forwardStdout ? "pipe" : "ignore", "pipe"]
    });

    this.process = child;
    this.stopRequested = false;
    logger.info("managed tuttid spawned", {
      pid: child.pid ?? null
    });

    if (forwardStdout) {
      child.stdout?.on("data", (chunk: Buffer | string) => {
        process.stdout.write(`[tuttid] ${chunk.toString()}`);
      });
    }

    child.stderr?.on("data", (chunk: Buffer | string) => {
      process.stderr.write(`[tuttid] ${chunk.toString()}`);
      getDesktopLogger().error("managed tuttid stderr", {
        chunk: chunk.toString().trim(),
        error_code: desktopErrorCodes.managedProcessStderr
      });
    });

    child.on("exit", (code, signal) => {
      const pid = child.pid ?? null;
      this.process = null;

      if (!this.stopRequested) {
        getDesktopLogger().error("managed tuttid exited unexpectedly", {
          pid,
          code,
          signal,
          error_code: desktopErrorCodes.managedProcessExited
        });
        void this.restartController.notifyExited();
      }
    });

    try {
      this.endpoint.boundAddr = await waitForListenerInfo(
        this.endpoint.listenerInfoPath,
        () => this.isProcessAlive()
      );
      await waitUntilHealthy(this.tuttidClient, () => this.isProcessAlive());
    } catch (error) {
      await this.terminateProcess();
      throw error;
    }

    this.restartController.notifyStarted();
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    await this.terminateProcess();
  }

  private async terminateProcess(): Promise<void> {
    this.endpoint.boundAddr = null;

    const child = this.process;
    if (!child) {
      await clearListenerInfo(this.endpoint.listenerInfoPath);
      return;
    }

    if (child.exitCode !== null || child.signalCode !== null) {
      this.process = null;
      await clearListenerInfo(this.endpoint.listenerInfoPath);
      return;
    }

    const exited = waitForChildExit(child, shutdownTimeoutMs, () => {
      if (child.exitCode === null && child.signalCode === null) {
        terminateProcessTree(child, "SIGKILL");
      }
    });

    terminateProcessTree(child, "SIGTERM");
    await exited;
    this.process = null;
    this.endpoint.boundAddr = null;
    await clearListenerInfo(this.endpoint.listenerInfoPath);
  }

  private isProcessAlive(): boolean {
    if (!this.process) {
      return false;
    }

    return this.process.exitCode === null && this.process.signalCode === null;
  }
}

function resolveEndpointEnv(
  endpoint: DesktopDaemonEndpoint
): Record<string, string> {
  return {
    TUTTID_ACCESS_TOKEN: endpoint.accessToken,
    TUTTID_ADDR: endpoint.requestedAddr
  };
}

export interface ManagedDaemonProcessEnvInput {
  endpoint: DesktopDaemonEndpoint;
  logDir?: string;
  logOutput: string;
  parentPID?: number;
  sessionID?: string;
  userShellEnv?: Record<string, string>;
}

// Relative path (under the packaged Resources dir) to the vendored
// chrome-devtools-mcp entry script. Kept in sync with the desktop build's
// extraResources staging (apps/desktop build/browser-mcp).
const vendoredBrowserMcpRelPath = join(
  "bin",
  "browser-mcp",
  "node_modules",
  "chrome-devtools-mcp",
  "build",
  "src",
  "bin",
  "chrome-devtools-mcp.js"
);
const vendoredClaudeSDKSidecarRelPath = join(
  "bin",
  "claude-sdk-sidecar",
  "src",
  "main.ts"
);

// resolveBrowserMcpDaemonEnv points the daemon at a vendored chrome-devtools-mcp
// in packaged builds so browser use never has to fetch it over the network at
// runtime. The daemon still owns browser connection-mode arguments because they
// come from persisted desktop preferences.
export function resolveBrowserMcpDaemonEnv(
  runtime?: DesktopElectronAppRuntime
): Record<string, string> {
  if (
    process.env.TUTTI_BROWSER_MCP_COMMAND?.trim() ||
    process.env.TUTTI_BROWSER_MCP_ARGS?.trim()
  ) {
    return {};
  }
  let appRuntime: DesktopElectronAppRuntime;
  try {
    appRuntime = runtime ?? resolveElectronAppRuntime();
  } catch {
    return {};
  }
  if (!appRuntime.isPackaged) {
    return {};
  }
  const entry = join(appRuntime.resourcesPath, vendoredBrowserMcpRelPath);
  if (!existsSync(entry)) {
    return {};
  }
  return {
    TUTTI_BROWSER_MCP_ENTRY_PATH: entry
  };
}

export function resolveClaudeSDKSidecarDaemonEnv(
  runtime?: DesktopElectronAppRuntime
): Record<string, string> {
  if (
    process.env.TUTTI_CLAUDE_SDK_SIDECAR_COMMAND?.trim() ||
    process.env.TUTTI_CLAUDE_SDK_SIDECAR_ENTRY_PATH?.trim()
  ) {
    return {};
  }
  let appRuntime: DesktopElectronAppRuntime;
  try {
    appRuntime = runtime ?? resolveElectronAppRuntime();
  } catch {
    return {};
  }
  if (!appRuntime.isPackaged) {
    return {};
  }
  const entry = join(appRuntime.resourcesPath, vendoredClaudeSDKSidecarRelPath);
  if (!existsSync(entry)) {
    return {};
  }
  return {
    TUTTI_CLAUDE_SDK_SIDECAR_ENTRY_PATH: entry
  };
}

function resolveManagedRuntimeDaemonEnv(
  userShellEnv?: Record<string, string>
): Record<string, string> {
  const rootOverride =
    process.env.TUTTI_APP_RUNTIME_ROOT?.trim() ||
    userShellEnv?.TUTTI_APP_RUNTIME_ROOT?.trim();
  const cacheRootOverride =
    process.env.TUTTI_APP_RUNTIME_CACHE_ROOT?.trim() ||
    userShellEnv?.TUTTI_APP_RUNTIME_CACHE_ROOT?.trim();
  if (rootOverride || cacheRootOverride) {
    return {};
  }
  return {
    TUTTI_APP_RUNTIME_CACHE_ROOT: join(
      resolveDesktopDefaultsFromEnv().state.rootDir,
      "app-runtimes"
    )
  };
}

export function resolveManagedDaemonProcessEnv(
  input: ManagedDaemonProcessEnvInput
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...(input.userShellEnv ?? {}),
    ...resolveEndpointEnv(input.endpoint),
    ...resolveManagedRuntimeDaemonEnv(input.userShellEnv),
    ...resolveBrowserMcpDaemonEnv(),
    ...resolveClaudeSDKSidecarDaemonEnv(),
    TUTTI_APP_VERSION: process.env.TUTTI_APP_VERSION?.trim() ?? "",
    TUTTI_DESKTOP_PARENT_PID: String(input.parentPID ?? process.pid),
    TUTTI_LOG_DIR: input.logDir ?? resolveDesktopLogsDir(),
    TUTTI_SESSION_ID: input.sessionID ?? getDesktopLogSessionID(),
    TUTTID_LOG_OUTPUT: input.logOutput,
    TUTTI_ENV: resolveTuttiEnv()
  };
}

async function resolveManagedDaemonUserShellEnv(): Promise<
  Record<string, string>
> {
  const logger = getDesktopLogger();
  try {
    const env = await resolveCachedUserShellEnv();
    const keys = Object.keys(env);
    if (keys.length > 0) {
      logger.info("resolved user shell env for managed tuttid", {
        keys: keys.sort(),
        pathResolved: typeof env.PATH === "string" && env.PATH.trim() !== ""
      });
    }
    return env;
  } catch (error) {
    logger.warn("failed to resolve user shell env for managed tuttid", {
      error: formatErrorMessage(error)
    });
    return {};
  }
}

export function resolveLaunchSpec(
  runtime?: DesktopElectronAppRuntime,
  options: ResolveLaunchSpecOptions = {}
): LaunchSpec {
  const binaryOverride = process.env.TUTTID_BIN?.trim();
  if (binaryOverride) {
    return {
      command: binaryOverride,
      args: []
    };
  }

  const appRuntime = runtime ?? resolveElectronAppRuntime();
  if (appRuntime.isPackaged) {
    const binaryName = process.platform === "win32" ? "tuttid.exe" : "tuttid";

    return {
      command: join(appRuntime.resourcesPath, "bin", binaryName),
      args: []
    };
  }

  const repoRoot = options.repoRoot ?? resolveRepoRoot();
  const devBinaryPath = resolve(
    repoRoot,
    "apps/desktop/build/tuttid",
    process.platform === "win32" ? "tuttid.exe" : "tuttid"
  );
  if (
    isExecutable(devBinaryPath) &&
    isFreshDevelopmentTuttidBinary(devBinaryPath, repoRoot)
  ) {
    return {
      command: devBinaryPath,
      args: []
    };
  }

  return {
    command: "go",
    args: ["run", "."],
    cwd: resolve(repoRoot, "services/tuttid")
  };
}

function isFreshDevelopmentTuttidBinary(
  binaryPath: string,
  repoRoot: string
): boolean {
  const sourceSentinelPaths = [
    resolve(repoRoot, "services/tuttid/api/events/generated/protocol.gen.go")
  ];

  let binaryModifiedAt: number;
  try {
    binaryModifiedAt = statSync(binaryPath).mtimeMs;
  } catch {
    return false;
  }

  return sourceSentinelPaths.every((sourcePath) => {
    if (!existsSync(sourcePath)) {
      return true;
    }

    return statSync(sourcePath).mtimeMs <= binaryModifiedAt;
  });
}

function resolveElectronAppRuntime(): DesktopElectronAppRuntime {
  const electron = require("electron") as {
    app: { isPackaged: boolean };
  };
  return {
    isPackaged: electron.app.isPackaged,
    resourcesPath: process.resourcesPath
  };
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveDaemonLogOutput(): string {
  const override = process.env.TUTTID_LOG_OUTPUT?.trim().toLowerCase();
  if (override === "stdout" || override === "tee" || override === "file") {
    return override;
  }

  return "file";
}

function shouldForwardDaemonStdout(logOutput: string): boolean {
  if (process.env.TUTTID_FORWARD_STDIO?.trim() === "1") {
    return true;
  }

  return logOutput === "stdout" || logOutput === "tee";
}

function resolveRepoRoot(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  let candidate = currentDir;
  for (;;) {
    if (
      existsSync(join(candidate, "pnpm-workspace.yaml")) &&
      existsSync(join(candidate, "services/tuttid"))
    ) {
      return candidate;
    }

    const parent = dirname(candidate);
    if (parent === candidate) {
      return resolve(currentDir, "../../../../");
    }
    candidate = parent;
  }
}

async function waitUntilHealthy(
  tuttidClient: TuttidClient,
  isAlive?: () => boolean
): Promise<void> {
  const deadline = Date.now() + healthTimeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    if (isAlive && !isAlive()) {
      throw new Error("tuttid exited before it became healthy.");
    }

    try {
      await tuttidClient.getHealth();
      return;
    } catch (error) {
      lastError = error;
      await sleep(healthPollIntervalMs);
    }
  }

  throw new Error(
    `Timed out waiting for tuttid health: ${formatError(lastError)}`
  );
}

async function waitForListenerInfo(
  listenerInfoPath: string,
  isAlive?: () => boolean
): Promise<string> {
  const deadline = Date.now() + healthTimeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    if (isAlive && !isAlive()) {
      throw new Error("tuttid exited before it published its listener info.");
    }

    try {
      return await readListenerInfo(listenerInfoPath);
    } catch (error) {
      lastError = error;
      await sleep(healthPollIntervalMs);
    }
  }

  throw new Error(
    `Timed out waiting for tuttid listener info: ${formatError(lastError)}`
  );
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    if (error.message.includes("ENOENT")) {
      return "daemon runtime information is not available yet";
    }
    if (error.message.includes("ECONNREFUSED")) {
      return "daemon refused the desktop connection";
    }
    if (error.message.includes("timed out")) {
      return "daemon did not become healthy before the timeout";
    }
    return error.message;
  }

  return "unknown error";
}

async function readListenerInfo(listenerInfoPath: string): Promise<string> {
  const content = await readFile(listenerInfoPath, "utf8");
  const parsed = JSON.parse(content) as { addr?: unknown };

  if (typeof parsed.addr !== "string" || parsed.addr.trim() === "") {
    throw new Error("listener info file does not contain a valid addr field");
  }

  return parsed.addr.trim();
}

async function clearListenerInfo(listenerInfoPath: string): Promise<void> {
  await rm(listenerInfoPath, { force: true });
  await rm(`${listenerInfoPath}.tmp`, { force: true });
}

async function stopStaleTuttid(pidPath: string): Promise<void> {
  let rawPID: string;
  try {
    rawPID = await readFile(pidPath, "utf8");
  } catch {
    return;
  }

  const pid = Number.parseInt(rawPID.trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
    await rm(pidPath, { force: true });
    return;
  }

  if (!isProcessRunning(pid)) {
    await rm(pidPath, { force: true });
    return;
  }

  const command = readProcessCommand(pid);
  if (!isLikelyTuttidProcess(command)) {
    getDesktopLogger().warn("ignoring stale tuttid pid for unrelated process", {
      pid,
      pid_path: pidPath,
      command
    });
    await rm(pidPath, { force: true });
    return;
  }

  getDesktopLogger().warn("stopping stale tuttid process", {
    pid,
    pid_path: pidPath,
    command
  });

  signalProcessTree(pid, "SIGTERM");
  await waitForProcessExit(pid, staleProcessShutdownTimeoutMs);
  if (isProcessRunning(pid) && isLikelyTuttidProcess(readProcessCommand(pid))) {
    getDesktopLogger().warn("force stopping stale tuttid process", {
      pid,
      pid_path: pidPath
    });
    signalProcessTree(pid, "SIGKILL");
    await waitForProcessExit(pid, staleProcessShutdownTimeoutMs);
  }

  if (!isProcessRunning(pid)) {
    await rm(pidPath, { force: true });
  }
}

export function isLikelyTuttidProcess(command: string): boolean {
  const normalized = command.trim().toLowerCase();
  if (normalized === "") {
    return false;
  }

  return normalized
    .split(/\s+/)
    .some((part) => part.split("/").pop() === "tuttid");
}

function readProcessCommand(pid: number): string {
  const result = spawnSync(
    "ps",
    ["-p", String(pid), "-o", "comm=", "-o", "args="],
    {
      encoding: "utf8"
    }
  );
  if (result.status !== 0) {
    return "";
  }

  return result.stdout.trim();
}

function terminateProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals
): void {
  if (!child.pid) {
    return;
  }

  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the direct child when the process group is already gone.
    }
  }

  child.kill(signal);
}

function waitForChildExit(
  child: ChildProcess,
  timeoutMs: number,
  onTimeout: () => void
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }

  return new Promise((resolvePromise) => {
    const timeout = setTimeout(() => {
      child.off("exit", onExit);
      onTimeout();
      resolvePromise();
    }, timeoutMs);

    function onExit(): void {
      clearTimeout(timeout);
      resolvePromise();
    }

    child.once("exit", onExit);
  });
}

async function waitForProcessExit(
  pid: number,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) {
      return;
    }
    await sleep(100);
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// signalProcessTree signals a stale tuttid pid recovered from disk (i.e. not
// a ChildProcess we hold a handle to). A managed tuttid is always spawned
// with `detached: true` (see ManagedTuttid.start), which makes it the leader
// of its own process group, so signaling the negated pid reaches tuttid and
// every subprocess it spawned (Codex app-server, Claude SDK sidecar, etc.)
// in one shot. Without this, killing just the leader pid would leave any of
// its live provider subprocesses orphaned: an OS process does not exit just
// because its parent did, it is simply reparented and keeps running.
export function signalProcessTree(pid: number, signal: NodeJS.Signals): void {
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Fall back to the direct pid: the process group may already be
      // gone, or (defensively) this pid was not actually a group leader.
    }
  }

  try {
    process.kill(pid, signal);
  } catch {
    // Process already exited.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}
