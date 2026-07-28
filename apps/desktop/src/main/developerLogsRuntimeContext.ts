import { basename } from "node:path";
import type { DesktopResolvedDefaults } from "./defaults.ts";
import type { ExportedAgentSessionFile } from "./developerLogsAgentSessions.ts";

interface DeveloperLogsRuntimeFile {
  archivePath: string;
  path: string;
  sizeBytes: number;
}

export interface BuildDeveloperLogsRuntimeContextInput {
  defaults: Pick<DesktopResolvedDefaults, "state">;
  desktopVersion: string;
  agentSessionFiles: ExportedAgentSessionFile[];
  logFiles: DeveloperLogsRuntimeFile[];
  persistedLocale: string | null;
  preferredSystemLanguages: readonly string[] | null;
  systemLocale: string | null;
  transportSnapshot: unknown;
}

export function buildDeveloperLogsRuntimeContext(
  input: BuildDeveloperLogsRuntimeContextInput
) {
  return {
    defaults: input.defaults,
    locale: {
      preferredSystemLanguages: input.preferredSystemLanguages ?? [],
      persisted: input.persistedLocale,
      system: input.systemLocale
    },
    logFiles: input.logFiles.map((file) => ({
      archivePath: file.archivePath,
      name: basename(file.path),
      path: file.path,
      sizeBytes: file.sizeBytes
    })),
    agentSessionFiles: input.agentSessionFiles.map((file) => ({
      agentSessionID: file.agentSessionID,
      archivePath: file.archivePath,
      name: basename(file.archivePath),
      path: file.path,
      provider: file.provider,
      sizeBytes: file.sizeBytes,
      workspaceID: file.workspaceID
    })),
    overrides: collectRuntimeOverrides(),
    runtime: {
      desktopVersion: input.desktopVersion,
      electron: process.versions.electron,
      tuttiEnv: process.env.TUTTI_ENV,
      node: process.versions.node,
      platform: process.platform,
      release: process.release.name,
      sessionId: process.env.TUTTI_SESSION_ID
    },
    transport: sanitizeDeveloperLogsTransportSnapshot(input.transportSnapshot)
  };
}

const developerLogsTransportFields = [
  "boundAddr",
  "listenerInfoPath",
  "pidPath",
  "requestedAddr"
] as const;

export function sanitizeDeveloperLogsTransportSnapshot(
  snapshot: unknown
): Record<string, string | null> | null {
  if (
    snapshot === null ||
    typeof snapshot !== "object" ||
    Array.isArray(snapshot)
  ) {
    return null;
  }

  const source = snapshot as Record<string, unknown>;
  const safeSnapshot: Record<string, string | null> = {};
  for (const field of developerLogsTransportFields) {
    const value = source[field];
    if (typeof value === "string" || value === null) {
      safeSnapshot[field] = value;
    }
  }
  return safeSnapshot;
}

function collectRuntimeOverrides(): Record<string, string> {
  const supported = [
    "TUTTI_ENV",
    "TUTTI_STATE_DIR",
    "TUTTI_LOG_DIR",
    "TUTTI_LOG_MAX_SIZE_MB",
    "TUTTI_LOG_MAX_BACKUPS",
    "TUTTI_LOG_MAX_AGE_DAYS",
    "TUTTI_LOG_MAX_TOTAL_MB",
    "TUTTID_TRANSPORT",
    "TUTTID_ADDR",
    "TUTTID_SOCKET_PATH",
    "TUTTID_PIPE_PATH",
    "TUTTID_RUN_DIR",
    "TUTTID_DB_PATH",
    "TUTTID_PID_PATH",
    "TUTTID_LOG_PATH",
    "TUTTID_LOG_OUTPUT",
    "TUTTID_LOG_LEVEL",
    "TUTTID_FORWARD_STDIO",
    "TUTTI_DESKTOP_LOG_PATH",
    "TUTTI_DESKTOP_LOG_OUTPUT",
    "TUTTI_DESKTOP_LOG_LEVEL",
    "TUTTI_DESKTOP_USER_DATA_DIR",
    "TUTTI_SESSION_ID"
  ] as const;

  const entries = supported.flatMap((key) => {
    const value = process.env[key];
    return value ? [[key, value] as const] : [];
  });

  return Object.fromEntries(entries);
}
