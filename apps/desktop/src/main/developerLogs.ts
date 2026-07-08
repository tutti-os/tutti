import { createWriteStream } from "node:fs";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  truncate
} from "node:fs/promises";
import type { Dirent } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import type {
  ClearDeveloperLogsResult,
  DesktopDeveloperLogFileSummary,
  DesktopDeveloperLogKind,
  DesktopDeveloperLogsState,
  ExportDeveloperLogsResult
} from "../shared/contracts/ipc";
import type { DesktopResolvedDefaults } from "./defaults";
import {
  buildProviderAgentSessionRecordFiles,
  type DeveloperLogsAgentSessionRecord,
  type ExportedAgentSessionFile
} from "./developerLogsAgentSessions.ts";
import yazl from "yazl";

export interface DeveloperLogsDependencies {
  appCenterSnapshotProvider?: () => Promise<DeveloperLogsAppCenterSnapshot | null>;
  agentSessionsProvider?: () => Promise<DeveloperLogsAgentSessionRecord[]>;
  defaults: Pick<DesktopResolvedDefaults, "state">;
  desktopVersion: string;
  flushLogs?: () => Promise<void> | void;
  getDownloadsPath?: () => string;
  persistedLocale?: string | null;
  preferredSystemLanguages?: readonly string[] | null;
  systemLocale?: string | null;
  transportSnapshot?: unknown;
}

export interface DeveloperLogsAppCenterSnapshot {
  workspaces: Array<{
    appFactoryJobsResponse: unknown;
    appsResponse: unknown;
    workspaceId: string;
  }>;
}

const managedDesktopLogPrefixes = ["tutti-desktop"];
const managedDaemonLogPrefixes = ["tuttid"];

type DeveloperDiagnosticsArtifact =
  | {
      kind: "file";
      category: "managed-log" | "workspace-app-log" | "app-factory-log";
      path: string;
      archivePath: string;
      sizeBytes: number;
      clearable: true;
      clearMode: "truncate" | "remove";
    }
  | {
      kind: "generated";
      category: "agent-session";
      archivePath: string;
      content: Buffer;
      sizeBytes: number;
      clearable: false;
      agentSessionID: string;
      path: string;
      provider: "claude-code" | "codex" | "cursor";
      workspaceID: string;
    }
  | {
      kind: "generated";
      category: "app-center-snapshot";
      archivePath: string;
      content: Buffer;
      sizeBytes: number;
      clearable: false;
    };

export function createDeveloperLogsService(
  deps: DeveloperLogsDependencies
): DeveloperLogsService {
  return new DeveloperLogsService(deps);
}

export class DeveloperLogsService {
  private readonly deps: DeveloperLogsDependencies;

  constructor(deps: DeveloperLogsDependencies) {
    this.deps = deps;
  }

  async getLogsState(): Promise<DesktopDeveloperLogsState> {
    await this.deps.flushLogs?.();
    const files = await Promise.all([
      summarizeLogFile("daemon", this.deps.defaults.state.tuttidLogPath),
      summarizeLogFile("desktop", this.deps.defaults.state.desktopLogPath)
    ]);
    const managed = await listManagedLogFiles(this.deps.defaults.state.logsDir);

    return {
      desktopVersion: this.deps.desktopVersion,
      files,
      logsDir: this.deps.defaults.state.logsDir,
      totalFiles: managed.length,
      totalSizeBytes: managed.reduce((sum, file) => sum + file.sizeBytes, 0)
    };
  }

  async clearLogs(): Promise<ClearDeveloperLogsResult> {
    const artifacts = await discoverDeveloperDiagnosticsArtifacts(this.deps);
    let clearedFiles = 0;
    let clearedSizeBytes = 0;
    const clearedPaths: string[] = [];

    for (const artifact of artifacts) {
      if (!artifact.clearable) {
        continue;
      }

      if (artifact.clearMode === "truncate") {
        await truncate(artifact.path, 0);
      } else {
        await rm(artifact.path, { force: true });
      }
      clearedFiles += 1;
      clearedSizeBytes += artifact.sizeBytes;
      clearedPaths.push(artifact.path);
    }

    return {
      clearedFiles,
      clearedPaths,
      clearedSizeBytes
    };
  }

  async exportLogs(savePath?: string): Promise<ExportDeveloperLogsResult> {
    await this.deps.flushLogs?.();
    const artifacts = await discoverDeveloperDiagnosticsArtifacts(this.deps);
    const fileArtifacts = artifacts.filter(
      (
        artifact
      ): artifact is Extract<DeveloperDiagnosticsArtifact, { kind: "file" }> =>
        artifact.kind === "file"
    );
    const generatedArtifacts = artifacts.filter(
      (
        artifact
      ): artifact is Extract<
        DeveloperDiagnosticsArtifact,
        { kind: "generated" }
      > => artifact.kind === "generated"
    );
    const agentSessionArtifacts = generatedArtifacts.filter(
      (
        artifact
      ): artifact is Extract<
        DeveloperDiagnosticsArtifact,
        { category: "agent-session" }
      > => artifact.category === "agent-session"
    );
    const appCenterSnapshotIncluded = generatedArtifacts.some(
      (artifact) => artifact.category === "app-center-snapshot"
    );

    if (artifacts.length === 0) {
      return {
        canceled: false,
        fileCount: 0,
        filePath: await this.writeEmptyExport(savePath)
      };
    }

    const targetPath = savePath
      ? ensureZipFilePath(savePath)
      : ensureZipFilePath(
          join(
            this.deps.getDownloadsPath?.() ?? this.deps.defaults.state.logsDir,
            createDefaultDeveloperLogsExportFileName()
          )
        );

    await mkdir(dirname(targetPath), { recursive: true });

    const zipFile = new yazl.ZipFile();
    const output = createWriteStream(targetPath);
    const completed = new Promise<void>((resolveCompleted, rejectCompleted) => {
      output.on("close", resolveCompleted);
      output.on("error", rejectCompleted);
      zipFile.outputStream.on("error", rejectCompleted);
    });

    zipFile.outputStream.pipe(output);

    for (const artifact of fileArtifacts) {
      const content = await readFile(artifact.path);
      zipFile.addBuffer(content, artifact.archivePath);
    }
    for (const artifact of generatedArtifacts) {
      zipFile.addBuffer(artifact.content, artifact.archivePath);
    }

    const runtimeContext = buildRuntimeContext({
      defaults: this.deps.defaults,
      desktopVersion: this.deps.desktopVersion,
      agentSessionFiles: agentSessionArtifacts.map((artifact) => ({
        agentSessionID: artifact.agentSessionID,
        archivePath: artifact.archivePath,
        content: artifact.content,
        path: artifact.path,
        provider: artifact.provider,
        sizeBytes: artifact.sizeBytes,
        workspaceID: artifact.workspaceID
      })),
      logFiles: fileArtifacts.map((artifact) => ({
        archivePath: artifact.archivePath,
        path: artifact.path,
        sizeBytes: artifact.sizeBytes
      })),
      persistedLocale: this.deps.persistedLocale ?? null,
      preferredSystemLanguages: this.deps.preferredSystemLanguages ?? null,
      systemLocale: this.deps.systemLocale ?? null,
      transportSnapshot: this.deps.transportSnapshot ?? null
    });

    zipFile.addBuffer(
      Buffer.from(JSON.stringify(runtimeContext, null, 2), "utf8"),
      "runtime-context.json"
    );
    zipFile.addBuffer(
      Buffer.from(
        JSON.stringify(
          {
            schemaVersion: 1,
            desktopVersion: this.deps.desktopVersion,
            exportedAt: new Date().toISOString(),
            logsDir: this.deps.defaults.state.logsDir,
            agentSessionFileCount: agentSessionArtifacts.length,
            appCenterSnapshotIncluded,
            appFactoryLogFileCount: fileArtifacts.filter(
              (artifact) => artifact.category === "app-factory-log"
            ).length,
            appLogFileCount: fileArtifacts.filter(
              (artifact) => artifact.category === "workspace-app-log"
            ).length,
            fileCount: fileArtifacts.length + generatedArtifacts.length,
            managedLogFileCount: fileArtifacts.filter(
              (artifact) => artifact.category === "managed-log"
            ).length,
            totalSizeBytes: artifacts.reduce(
              (sum, artifact) => sum + artifact.sizeBytes,
              0
            )
          },
          null,
          2
        ),
        "utf8"
      ),
      "export-summary.json"
    );

    zipFile.end();
    await completed;

    return {
      canceled: false,
      fileCount: fileArtifacts.length + generatedArtifacts.length,
      filePath: targetPath
    };
  }

  private async writeEmptyExport(savePath?: string): Promise<string> {
    const targetPath = ensureZipFilePath(
      savePath ??
        join(
          this.deps.getDownloadsPath?.() ?? this.deps.defaults.state.logsDir,
          createDefaultDeveloperLogsExportFileName()
        )
    );
    await mkdir(dirname(targetPath), { recursive: true });
    const zipFile = new yazl.ZipFile();
    const output = createWriteStream(targetPath);
    const completed = new Promise<void>((resolveCompleted, rejectCompleted) => {
      output.on("close", resolveCompleted);
      output.on("error", rejectCompleted);
      zipFile.outputStream.on("error", rejectCompleted);
    });
    zipFile.outputStream.pipe(output);
    const runtimeContext = buildRuntimeContext({
      defaults: this.deps.defaults,
      desktopVersion: this.deps.desktopVersion,
      agentSessionFiles: [],
      logFiles: [],
      persistedLocale: this.deps.persistedLocale ?? null,
      preferredSystemLanguages: this.deps.preferredSystemLanguages ?? null,
      systemLocale: this.deps.systemLocale ?? null,
      transportSnapshot: this.deps.transportSnapshot ?? null
    });
    zipFile.addBuffer(
      Buffer.from(JSON.stringify(runtimeContext, null, 2), "utf8"),
      "runtime-context.json"
    );
    zipFile.addBuffer(
      Buffer.from(
        JSON.stringify(
          {
            schemaVersion: 1,
            desktopVersion: this.deps.desktopVersion,
            exportedAt: new Date().toISOString(),
            logsDir: this.deps.defaults.state.logsDir,
            agentSessionFileCount: 0,
            fileCount: 0,
            totalSizeBytes: 0
          },
          null,
          2
        ),
        "utf8"
      ),
      "export-summary.json"
    );
    zipFile.end();
    await completed;
    return targetPath;
  }
}

interface ManagedLogFile {
  path: string;
  sizeBytes: number;
}

interface DiscoveredLogFile extends ManagedLogFile {
  archivePath: string;
}

async function discoverDeveloperDiagnosticsArtifacts(
  deps: DeveloperLogsDependencies
): Promise<DeveloperDiagnosticsArtifact[]> {
  const activeManagedLogPaths = new Set([
    deps.defaults.state.tuttidLogPath,
    deps.defaults.state.desktopLogPath
  ]);
  const managedFiles = await listManagedLogFiles(deps.defaults.state.logsDir);
  const appLogFiles = await listWorkspaceAppLogFiles(
    deps.defaults.state.rootDir
  );
  const appFactoryLogFiles = await listAppFactoryLogFiles(
    deps.defaults.state.rootDir
  );
  const agentSessions = await deps.agentSessionsProvider?.().catch(() => []);
  const agentSessionFiles = buildProviderAgentSessionRecordFiles(
    agentSessions ?? []
  );
  const appCenterSnapshot = await deps
    .appCenterSnapshotProvider?.()
    .catch(() => null);

  const artifacts: DeveloperDiagnosticsArtifact[] = [
    ...managedFiles.map(
      (file): DeveloperDiagnosticsArtifact => ({
        kind: "file",
        category: "managed-log",
        path: file.path,
        archivePath: joinZipPath("logs", basename(file.path)),
        sizeBytes: file.sizeBytes,
        clearable: true,
        clearMode: activeManagedLogPaths.has(file.path) ? "truncate" : "remove"
      })
    ),
    ...appLogFiles.map(
      (file): DeveloperDiagnosticsArtifact => ({
        kind: "file",
        category: "workspace-app-log",
        path: file.path,
        archivePath: file.archivePath,
        sizeBytes: file.sizeBytes,
        clearable: true,
        clearMode: "remove"
      })
    ),
    ...appFactoryLogFiles.map(
      (file): DeveloperDiagnosticsArtifact => ({
        kind: "file",
        category: "app-factory-log",
        path: file.path,
        archivePath: file.archivePath,
        sizeBytes: file.sizeBytes,
        clearable: true,
        clearMode: "remove"
      })
    ),
    ...agentSessionFiles.map(
      (file): DeveloperDiagnosticsArtifact => ({
        kind: "generated",
        category: "agent-session",
        archivePath: file.archivePath,
        content: file.content,
        sizeBytes: file.sizeBytes,
        clearable: false,
        agentSessionID: file.agentSessionID,
        path: file.path,
        provider: file.provider,
        workspaceID: file.workspaceID
      })
    )
  ];

  if (appCenterSnapshot) {
    const content = Buffer.from(
      JSON.stringify(appCenterSnapshot, null, 2),
      "utf8"
    );
    artifacts.push({
      kind: "generated",
      category: "app-center-snapshot",
      archivePath: "app-center-snapshot.json",
      content,
      sizeBytes: content.byteLength,
      clearable: false
    });
  }

  return artifacts;
}

function createDefaultDeveloperLogsExportFileName(now = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(
    now.getHours()
  )}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `tutti-logs-${stamp}.zip`;
}

interface BuildRuntimeContextInput {
  defaults: Pick<DesktopResolvedDefaults, "state">;
  desktopVersion: string;
  agentSessionFiles: ExportedAgentSessionFile[];
  logFiles: DiscoveredLogFile[];
  persistedLocale: string | null;
  preferredSystemLanguages: readonly string[] | null;
  systemLocale: string | null;
  transportSnapshot: unknown;
}

function buildRuntimeContext(input: BuildRuntimeContextInput): {
  defaults: Pick<DesktopResolvedDefaults, "state">;
  locale: {
    preferredSystemLanguages: readonly string[];
    persisted: string | null;
    system: string | null;
  };
  logFiles: Array<{
    archivePath: string;
    name: string;
    path: string;
    sizeBytes: number;
  }>;
  agentSessionFiles: Array<{
    agentSessionID: string;
    archivePath: string;
    name: string;
    path: string;
    provider: string;
    sizeBytes: number;
    workspaceID: string;
  }>;
  overrides: Record<string, string>;
  runtime: {
    desktopVersion: string;
    electron: string | undefined;
    tuttiEnv: string | undefined;
    node: string | undefined;
    platform: NodeJS.Platform;
    release: string;
    sessionId: string | undefined;
  };
  transport: unknown;
} {
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
    transport: input.transportSnapshot
  };
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
    "TUTTI_SESSION_ID"
  ] as const;

  const entries = supported.flatMap((key) => {
    const value = process.env[key];
    return value ? [[key, value] as const] : [];
  });

  return Object.fromEntries(entries);
}

async function summarizeLogFile(
  kind: DesktopDeveloperLogKind,
  path: string
): Promise<DesktopDeveloperLogFileSummary> {
  try {
    const info = await stat(path);
    return {
      exists: true,
      kind,
      path,
      sizeBytes: info.size
    };
  } catch {
    return {
      exists: false,
      kind,
      path,
      sizeBytes: 0
    };
  }
}

async function listManagedLogFiles(logsDir: string): Promise<ManagedLogFile[]> {
  let names: string[];
  try {
    names = await readdir(logsDir);
  } catch {
    return [];
  }

  const files = await Promise.all(
    names.filter(isManagedTuttiLogFileName).map(async (name) => {
      const path = join(logsDir, name);
      try {
        const info = await stat(path);
        if (!info.isFile()) {
          return null;
        }

        return {
          path,
          sizeBytes: info.size
        } satisfies ManagedLogFile;
      } catch {
        return null;
      }
    })
  );

  return files.filter((file): file is ManagedLogFile => file !== null);
}

async function listWorkspaceAppLogFiles(
  stateRootDir: string
): Promise<DiscoveredLogFile[]> {
  const appInstallationsDir = join(stateRootDir, "apps", "installations");
  let appEntries: Dirent[];
  try {
    appEntries = await readdir(appInstallationsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const appFiles = await Promise.all(
    appEntries
      .filter((entry) => entry.isDirectory())
      .map(async (appEntry) => {
        const appID = appEntry.name;
        const appDir = join(appInstallationsDir, appID);
        let scopeEntries: Dirent[];
        try {
          scopeEntries = await readdir(appDir, { withFileTypes: true });
        } catch {
          return [];
        }

        const scopeFiles = await Promise.all(
          scopeEntries
            .filter((entry) => entry.isDirectory())
            .map((scopeEntry) =>
              listWorkspaceAppLogDirFiles({
                appID,
                logsDir: join(appDir, scopeEntry.name, "logs"),
                scopeID: scopeEntry.name
              })
            )
        );
        return scopeFiles.flat();
      })
  );

  return appFiles.flat();
}

async function listWorkspaceAppLogDirFiles(input: {
  appID: string;
  logsDir: string;
  scopeID: string;
}): Promise<DiscoveredLogFile[]> {
  const files: DiscoveredLogFile[] = [];
  const pending = [input.logsDir];

  while (pending.length > 0) {
    const currentDir = pending.pop();
    if (!currentDir) {
      continue;
    }

    let entries: Dirent[];
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const path = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      try {
        const info = await lstat(path);
        if (!info.isFile()) {
          continue;
        }
        files.push({
          archivePath: joinZipPath(
            "app-logs",
            safeZipPathSegment(input.appID),
            safeZipPathSegment(input.scopeID),
            ...relative(input.logsDir, path)
              .split(/[\\/]+/)
              .map(safeZipPathSegment)
          ),
          path,
          sizeBytes: info.size
        });
      } catch {
        continue;
      }
    }
  }

  return files;
}

async function listAppFactoryLogFiles(
  stateRootDir: string
): Promise<DiscoveredLogFile[]> {
  const factoryJobsDir = join(stateRootDir, "apps", "factory", "jobs");
  let jobEntries: Dirent[];
  try {
    jobEntries = await readdir(factoryJobsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const jobFiles = await Promise.all(
    jobEntries
      .filter((entry) => entry.isDirectory())
      .map((jobEntry) =>
        listAppFactoryJobLogDirFiles({
          jobID: jobEntry.name,
          logsDir: join(factoryJobsDir, jobEntry.name, "logs")
        })
      )
  );

  return jobFiles.flat();
}

async function listAppFactoryJobLogDirFiles(input: {
  jobID: string;
  logsDir: string;
}): Promise<DiscoveredLogFile[]> {
  const files: DiscoveredLogFile[] = [];
  const pending = [input.logsDir];

  while (pending.length > 0) {
    const currentDir = pending.pop();
    if (!currentDir) {
      continue;
    }

    let entries: Dirent[];
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const path = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      try {
        const info = await lstat(path);
        if (!info.isFile()) {
          continue;
        }
        files.push({
          archivePath: joinZipPath(
            "app-factory-logs",
            safeZipPathSegment(input.jobID),
            ...relative(input.logsDir, path)
              .split(/[\\/]+/)
              .map(safeZipPathSegment)
          ),
          path,
          sizeBytes: info.size
        });
      } catch {
        continue;
      }
    }
  }

  return files;
}

function ensureZipFilePath(filePath: string): string {
  return filePath.toLowerCase().endsWith(".zip") ? filePath : `${filePath}.zip`;
}

function joinZipPath(...parts: string[]): string {
  return parts
    .map((part) => part.replaceAll("\\", "/").replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .join("/");
}

function isManagedTuttiLogFileName(name: string): boolean {
  const match = /^(.*)\.log$/i.exec(name);
  if (!match) {
    return false;
  }

  const base = (match[1] ?? "").toLowerCase();
  return (
    matchesManagedPrefix(base, managedDesktopLogPrefixes) ||
    matchesManagedPrefix(base, managedDaemonLogPrefixes)
  );
}

function matchesManagedPrefix(base: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) => {
    if (base === prefix) {
      return true;
    }

    if (!base.startsWith(`${prefix}.`)) {
      return false;
    }

    const suffix = base.slice(prefix.length + 1);
    return /^\d{4}-\d{2}-\d{2}(?:\.\d+)?$/.test(suffix);
  });
}

function safeZipPathSegment(value: string): string {
  const safe = value.trim().replaceAll(/[^\p{L}\p{N}_.-]/gu, "_");
  if (safe === "" || safe === "." || safe === "..") {
    return "_";
  }
  return safe;
}
