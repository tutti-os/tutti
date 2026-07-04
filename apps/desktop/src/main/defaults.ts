import { join } from "node:path";
import { homedir } from "node:os";
import { generatedDefaults } from "./generated/defaults.ts";

export interface DesktopResolvedDefaults {
  runtime: {
    env: "development" | "production";
  };
  state: {
    rootDir: string;
    logsDir: string;
    runDir: string;
    tuttidDBPath: string;
    tuttidListenerInfoPath: string;
    tuttidLogPath: string;
    desktopLogPath: string;
    tuttidPIDPath: string;
  };
  transport: {
    tcpAddr: string;
  };
  logging: {
    defaultLevel: "debug" | "info" | "warn" | "error";
    defaultOutput: "file" | "stdout" | "tee";
    maxSizeMB: number;
    maxBackups: number;
    maxAgeDays: number;
    maxTotalMB: number;
  };
}

export interface DesktopProtocolClientRegistration {
  scheme: "tutti" | "tutti-dev";
}

export function initializeDesktopEnvironment(options?: {
  appVersion?: string;
  isPackaged?: boolean;
}): void {
  if (!process.env.TUTTI_ENV?.trim()) {
    process.env.TUTTI_ENV = options?.isPackaged ? "production" : "development";
  }

  const appVersion = options?.appVersion?.trim();
  if (!process.env.TUTTI_APP_VERSION?.trim() && appVersion) {
    process.env.TUTTI_APP_VERSION = appVersion;
  }
}

export function resolveDesktopUserDataPath(options: {
  appDataDir: string;
  appName: string;
}): string | null {
  if (resolveTuttiEnv() !== "development") {
    return null;
  }

  const appName = options.appName.trim() || "Tutti";
  return join(options.appDataDir, `${appName}-dev`);
}

export function resolveDesktopDevelopmentAppName(
  appName: string
): string | null {
  if (resolveTuttiEnv() !== "development") {
    return null;
  }

  const safeAppName = appName.trim() || "Tutti";
  return `${safeAppName} Dev`;
}

export function resolveDesktopLoginProtocolScheme(): "tutti" | "tutti-dev" {
  return resolveTuttiEnv() === "development" ? "tutti-dev" : "tutti";
}

export function resolveDesktopLoginCallbackUrl(): string {
  return `${resolveDesktopLoginProtocolScheme()}://login/callback`;
}

export function resolveDesktopLoginProtocolClientRegistration(options: {
  isPackaged: boolean;
}): DesktopProtocolClientRegistration {
  const scheme = resolveDesktopLoginProtocolScheme();
  if (resolveTuttiEnv() === "development" && !options.isPackaged) {
    return { scheme };
  }

  return { scheme };
}

export function resolveDesktopDefaultsFromEnv(): DesktopResolvedDefaults {
  const env = resolveTuttiEnv();
  const stateRootDir = resolveStateRootDir(env);
  const logsDir = resolveLogsDir(stateRootDir);
  const runDir = resolveRunDir(stateRootDir);

  return {
    runtime: {
      env
    },
    state: {
      rootDir: stateRootDir,
      logsDir,
      runDir,
      tuttidDBPath: resolveDBPath(stateRootDir),
      tuttidListenerInfoPath: resolveListenerInfoPath(runDir),
      tuttidLogPath: resolveDaemonLogPath(logsDir),
      desktopLogPath: resolveDesktopLogPath(logsDir),
      tuttidPIDPath: resolvePIDPath(runDir)
    },
    transport: {
      tcpAddr: resolveTCPAddr()
    },
    logging: {
      defaultLevel: generatedDefaults.logging.defaultLevel,
      defaultOutput: generatedDefaults.logging.defaultOutput,
      maxSizeMB: generatedDefaults.logging.maxSizeMB,
      maxBackups: generatedDefaults.logging.maxBackups,
      maxAgeDays: generatedDefaults.logging.maxAgeDays,
      maxTotalMB: generatedDefaults.logging.maxTotalMB
    }
  };
}

export function resolveTuttiEnv(): "development" | "production" {
  return process.env.TUTTI_ENV?.trim().match(/^(dev|development|local)$/i)
    ? "development"
    : "production";
}

function resolveStateRootDir(env: "development" | "production"): string {
  const override = process.env.TUTTI_STATE_DIR?.trim();
  if (override) {
    return override;
  }

  const homeDir = homedir();
  const dirName =
    env === "development"
      ? generatedDefaults.state.developmentDirName
      : generatedDefaults.state.productionDirName;

  return join(homeDir, dirName);
}

function resolveLogsDir(stateRootDir: string): string {
  const override = process.env.TUTTI_LOG_DIR?.trim();
  if (override) {
    return override;
  }

  return join(stateRootDir, generatedDefaults.state.logsDirName);
}
function resolveRunDir(stateRootDir: string): string {
  const override = process.env.TUTTID_RUN_DIR?.trim();
  if (override) {
    return override;
  }

  return join(stateRootDir, generatedDefaults.state.runDirName);
}

function resolveDBPath(stateRootDir: string): string {
  const override = process.env.TUTTID_DB_PATH?.trim();
  if (override) {
    return override;
  }

  return join(stateRootDir, generatedDefaults.state.dbFileName);
}

function resolveDaemonLogPath(logsDir: string): string {
  const override = process.env.TUTTID_LOG_PATH?.trim();
  if (override) {
    return override;
  }

  return join(logsDir, generatedDefaults.state.daemonLogFileName);
}

function resolveDesktopLogPath(logsDir: string): string {
  const override = process.env.TUTTI_DESKTOP_LOG_PATH?.trim();
  if (override) {
    return override;
  }

  return join(logsDir, generatedDefaults.state.desktopLogFileName);
}

function resolvePIDPath(runDir: string): string {
  const override = process.env.TUTTID_PID_PATH?.trim();
  if (override) {
    return override;
  }

  return join(runDir, generatedDefaults.state.pidFileName);
}

function resolveListenerInfoPath(runDir: string): string {
  const override = process.env.TUTTID_LISTENER_INFO_PATH?.trim();
  if (override) {
    return override;
  }

  return join(runDir, generatedDefaults.state.listenerInfoFileName);
}

function resolveTCPAddr(): string {
  return (
    process.env.TUTTID_ADDR?.trim() ||
    generatedDefaults.transport.defaultTCPAddr
  );
}
