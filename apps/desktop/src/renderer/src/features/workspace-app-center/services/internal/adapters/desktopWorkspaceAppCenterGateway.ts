import type {
  TuttidClient,
  WorkspaceApp,
  WorkspaceAppCatalogLoadStatus,
  WorkspaceAppFactoryJob as TuttidWorkspaceAppFactoryJob,
  WorkspaceAppFactoryJobListResponse,
  WorkspaceAppFactoryJobStatus as TuttidWorkspaceAppFactoryJobStatus,
  WorkspaceAppListResponse,
  WorkspaceAppRuntimeStatus
} from "@tutti-os/client-tuttid-ts";
import type {
  WorkspaceAppFactoryJob,
  WorkspaceAppFactoryJobStatus,
  WorkspaceAppFactorySnapshot,
  WorkspaceAppCenterApp,
  WorkspaceAppCenterCatalogStatus,
  WorkspaceAppCenterGateway,
  WorkspaceAppCenterLocalization,
  WorkspaceAppCenterSource,
  WorkspaceAppCenterRuntimeStatus,
  WorkspaceAppCenterSnapshot
} from "@tutti-os/workspace-app-center";
import { mapWorkspaceAppRuntimeStatus } from "@tutti-os/workspace-app-center/core";

export interface DesktopWorkspaceAppExportResult {
  appId: string;
  archivePath: string;
  artifactSha256: string;
  artifactSizeBytes: number;
  version: string;
  workspaceId: string;
}

export interface DesktopWorkspaceAppCenterLocalFileGateway {
  exportWorkspaceApp(
    workspaceId: string,
    appId: string,
    input: { destinationPath: string; version?: string }
  ): Promise<DesktopWorkspaceAppExportResult>;
  importWorkspaceApp(
    workspaceId: string,
    input: { archivePath: string }
  ): Promise<WorkspaceAppCenterSnapshot>;
  replaceWorkspaceAppIcon(
    workspaceId: string,
    appId: string,
    input: { sourcePath: string }
  ): Promise<WorkspaceAppCenterApp>;
}

export interface WorkspaceAppLike {
  readonly appId: string;
  readonly authors?: readonly WorkspaceApp["authors"][number][];
  readonly cli?: WorkspaceApp["cli"];
  readonly availableIconUrl?: string | null;
  readonly availableVersion?: string | null;
  readonly createdAtUnixMs?: number | null;
  readonly description: string;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly exportable: boolean;
  readonly failureReason?: string | null;
  readonly iconUrl?: string | null;
  readonly installed: boolean;
  readonly installationId?: string | null;
  readonly lastError?: string | null;
  readonly launchUrl?: string | null;
  readonly localPackageDir?: string | null;
  readonly localizations?: readonly WorkspaceAppLocalizationLike[];
  readonly minimizeBehavior?: "hibernate" | "keep-mounted";
  readonly port?: number | null;
  readonly references?: WorkspaceApp["references"];
  readonly repository?:
    | WorkspaceApp["repository"]
    | Record<string, unknown>
    | null;
  readonly source: WorkspaceApp["source"];
  readonly startedAtUnixMs?: number | null;
  readonly stateRevision: number;
  readonly status: WorkspaceAppRuntimeStatus | string;
  readonly runtimeId?: string | null;
  readonly tags?: readonly string[];
  readonly updatedAtUnixMs?: number | null;
  readonly updateAvailable?: boolean;
  readonly version: string;
  readonly installProgress?:
    | WorkspaceApp["installProgress"]
    | Record<string, unknown>
    | null;
  readonly windowMinHeight?: number | null;
  readonly windowMinWidth?: number | null;
}

export interface WorkspaceAppLocalizationLike {
  readonly locale: string;
  readonly displayName?: string | null;
  readonly description?: string | null;
  readonly tags?: readonly string[];
}

export function createDesktopWorkspaceAppCenterGateway(
  tuttidClient: TuttidClient
): WorkspaceAppCenterGateway & DesktopWorkspaceAppCenterLocalFileGateway {
  return {
    async installWorkspaceApp(workspaceId, appId, input) {
      await tuttidClient.installWorkspaceApp(workspaceId, appId, input);
      return normalizeWorkspaceAppCenterSnapshot(
        await tuttidClient.listWorkspaceApps(workspaceId)
      );
    },
    async deleteWorkspaceApp(workspaceId, appId) {
      await tuttidClient.deleteWorkspaceApp(workspaceId, appId);
      return normalizeWorkspaceAppCenterSnapshot(
        await tuttidClient.listWorkspaceApps(workspaceId)
      );
    },
    async exportWorkspaceApp(workspaceId, appId, input) {
      return tuttidClient.exportWorkspaceApp(workspaceId, appId, input);
    },
    async importWorkspaceApp(workspaceId, input) {
      await tuttidClient.importWorkspaceApp(workspaceId, input);
      return normalizeWorkspaceAppCenterSnapshot(
        await tuttidClient.listWorkspaceApps(workspaceId)
      );
    },
    async loadLocalWorkspaceApp(workspaceId, input) {
      await tuttidClient.loadLocalWorkspaceApp(workspaceId, input);
      return normalizeWorkspaceAppCenterSnapshot(
        await tuttidClient.listWorkspaceApps(workspaceId)
      );
    },
    async replaceWorkspaceAppIcon(workspaceId, appId, input) {
      return normalizeWorkspaceAppCenterApp(
        await tuttidClient.replaceWorkspaceAppIcon(workspaceId, appId, input)
      );
    },
    async listWorkspaceApps(workspaceId) {
      return normalizeWorkspaceAppCenterSnapshot(
        await tuttidClient.listWorkspaceApps(workspaceId)
      );
    },
    async refreshWorkspaceAppCatalog(workspaceId) {
      return normalizeWorkspaceAppCenterSnapshot(
        await tuttidClient.refreshWorkspaceAppCatalog(workspaceId)
      );
    },
    async reloadLocalWorkspaceApp(workspaceId, appId, input) {
      await tuttidClient.reloadLocalWorkspaceApp(workspaceId, appId, input);
      return normalizeWorkspaceAppCenterSnapshot(
        await tuttidClient.listWorkspaceApps(workspaceId)
      );
    },
    async uninstallWorkspaceApp(workspaceId, appId) {
      await tuttidClient.uninstallWorkspaceApp(workspaceId, appId);
      return normalizeWorkspaceAppCenterSnapshot(
        await tuttidClient.listWorkspaceApps(workspaceId)
      );
    },
    async launchWorkspaceApp(workspaceId, appId) {
      await tuttidClient.launchWorkspaceApp(workspaceId, appId);
      return normalizeWorkspaceAppCenterSnapshot(
        await tuttidClient.listWorkspaceApps(workspaceId)
      );
    },
    async retryWorkspaceApp(workspaceId, appId) {
      await tuttidClient.retryWorkspaceApp(workspaceId, appId);
      return normalizeWorkspaceAppCenterSnapshot(
        await tuttidClient.listWorkspaceApps(workspaceId)
      );
    },
    async rollbackWorkspaceApp(workspaceId, appId, version) {
      await tuttidClient.rollbackWorkspaceApp(workspaceId, appId, { version });
      return normalizeWorkspaceAppCenterSnapshot(
        await tuttidClient.listWorkspaceApps(workspaceId)
      );
    },
    async listWorkspaceAppFactoryJobs(workspaceId) {
      return normalizeWorkspaceAppFactorySnapshot(
        await tuttidClient.listWorkspaceAppFactoryJobs(workspaceId)
      );
    },
    async createWorkspaceAppFactoryJob(workspaceId, input) {
      await tuttidClient.createWorkspaceAppFactoryJob(workspaceId, input);
      return normalizeWorkspaceAppFactorySnapshot(
        await tuttidClient.listWorkspaceAppFactoryJobs(workspaceId)
      );
    },
    async cancelWorkspaceAppFactoryJob(workspaceId, jobId) {
      await tuttidClient.cancelWorkspaceAppFactoryJob(workspaceId, jobId);
      return normalizeWorkspaceAppFactorySnapshot(
        await tuttidClient.listWorkspaceAppFactoryJobs(workspaceId)
      );
    },
    async deleteWorkspaceAppFactoryJob(workspaceId, jobId) {
      return normalizeWorkspaceAppFactorySnapshot(
        await tuttidClient.deleteWorkspaceAppFactoryJob(workspaceId, jobId)
      );
    },
    async retryWorkspaceAppFactoryJobValidation(workspaceId, jobId) {
      await tuttidClient.retryWorkspaceAppFactoryJobValidation(
        workspaceId,
        jobId
      );
      return normalizeWorkspaceAppFactorySnapshot(
        await tuttidClient.listWorkspaceAppFactoryJobs(workspaceId)
      );
    },
    async fixWorkspaceAppFactoryJob(workspaceId, jobId, input) {
      await tuttidClient.fixWorkspaceAppFactoryJob(workspaceId, jobId, input);
      return normalizeWorkspaceAppFactorySnapshot(
        await tuttidClient.listWorkspaceAppFactoryJobs(workspaceId)
      );
    },
    async prepareWorkspaceAppFactoryJobModification(workspaceId, jobId) {
      await tuttidClient.prepareWorkspaceAppFactoryJobModification(
        workspaceId,
        jobId
      );
      return normalizeWorkspaceAppFactorySnapshot(
        await tuttidClient.listWorkspaceAppFactoryJobs(workspaceId)
      );
    },
    async publishWorkspaceAppFactoryJob(workspaceId, jobId) {
      await tuttidClient.publishWorkspaceAppFactoryJob(workspaceId, jobId);
      const [apps, jobs] = await Promise.all([
        tuttidClient.listWorkspaceApps(workspaceId),
        tuttidClient.listWorkspaceAppFactoryJobs(workspaceId)
      ]);
      return {
        appSnapshot: normalizeWorkspaceAppCenterSnapshot(apps),
        factorySnapshot: normalizeWorkspaceAppFactorySnapshot(jobs)
      };
    },
    async startEnabledWorkspaceApps(workspaceId) {
      return normalizeWorkspaceAppCenterSnapshot(
        await tuttidClient.startEnabledWorkspaceApps(workspaceId)
      );
    }
  };
}

export function normalizeWorkspaceAppFactorySnapshot(
  response: WorkspaceAppFactoryJobListResponse
): WorkspaceAppFactorySnapshot {
  return {
    jobs: response.jobs.map(normalizeWorkspaceAppFactoryJob)
  };
}

export function normalizeWorkspaceAppFactoryJob(
  job: TuttidWorkspaceAppFactoryJob
): WorkspaceAppFactoryJob {
  return {
    agentTargetId: job.agentTargetId,
    agentSessionId: job.agentSessionId,
    appId: job.appId,
    createdAtUnixMs: job.createdAtUnixMs,
    description: job.description,
    displayName: job.displayName,
    failureReason: job.failureReason,
    jobId: job.jobId,
    model: job.model,
    prompt: job.prompt,
    provider: job.provider,
    reasoningEffort: job.reasoningEffort,
    publishedVersion: job.publishedVersion,
    status: normalizeFactoryJobStatus(job.status),
    updatedAtUnixMs: job.updatedAtUnixMs,
    validationResult: job.validationResult,
    workspaceId: job.workspaceId
  };
}

export function normalizeWorkspaceAppCenterSnapshot(
  response: WorkspaceAppListResponse
): WorkspaceAppCenterSnapshot {
  return {
    apps: response.apps.map(normalizeWorkspaceAppCenterApp),
    catalogLastError: response.catalogStatus.lastError,
    catalogStatus: normalizeCatalogStatus(response.catalogStatus.status),
    catalogUpdatedAtUnixMs: response.catalogStatus.updatedAtUnixMs
  };
}

function normalizeCatalogStatus(
  status: WorkspaceAppCatalogLoadStatus
): WorkspaceAppCenterCatalogStatus {
  switch (status) {
    case "failed":
      return "failed";
    case "loading":
      return "loading";
    case "ready":
      return "ready";
    default:
      return "disabled";
  }
}

function normalizeFactoryJobStatus(
  status: TuttidWorkspaceAppFactoryJobStatus
): WorkspaceAppFactoryJobStatus {
  switch (status) {
    case "canceled":
      return "canceled";
    case "failed":
      return "failed";
    case "generating":
      return "generating";
    case "preparing":
      return "preparing";
    case "published":
      return "published";
    case "ready":
      return "ready";
    case "validating":
      return "validating";
    case "queued":
      return "queued";
    default:
      return assertNever(
        status,
        "Unsupported workspace app factory job status"
      );
  }
}

export function normalizeWorkspaceAppCenterApp(
  app: WorkspaceAppLike
): WorkspaceAppCenterApp {
  return {
    appId: app.appId,
    authors: (app.authors ?? []).map((author) => ({
      avatarUrl: author.avatarUrl,
      name: author.name,
      url: author.url
    })),
    availableIconUrl: app.availableIconUrl,
    availableVersion: app.availableVersion,
    createdAtUnixMs: app.createdAtUnixMs ?? 0,
    description: app.description,
    enabled: app.enabled,
    exportable: app.exportable,
    failureReason: app.failureReason ?? null,
    iconUrl: app.iconUrl,
    installProgress: normalizeWorkspaceAppInstallProgress(app.installProgress),
    installed: app.installed,
    installationId: app.installationId ?? null,
    lastError: app.lastError ?? null,
    cli: normalizeWorkspaceAppCliState(app.cli),
    localPackageDir: app.localPackageDir ?? null,
    localizations: (app.localizations ?? []).map(
      normalizeWorkspaceAppLocalization
    ),
    minimizeBehavior:
      app.minimizeBehavior === "hibernate" ? "hibernate" : "keep-mounted",
    name: app.displayName,
    references: {
      listSupported: app.references?.listSupported ?? false
    },
    repository: normalizeWorkspaceAppRepository(app.repository),
    runtimeStatus: normalizeRuntimeStatus(app.status),
    runtimeId: app.runtimeId ?? null,
    source: normalizeWorkspaceAppCenterSource(app.source),
    stateRevision: app.stateRevision,
    tags: app.tags ?? [],
    updateAvailable: app.updateAvailable ?? false,
    launchUrl: app.status === "running" ? app.launchUrl : null,
    version: app.version,
    windowMinHeight: normalizeWorkspaceAppWindowMinimum(app.windowMinHeight),
    windowMinWidth: normalizeWorkspaceAppWindowMinimum(app.windowMinWidth)
  };
}

function normalizeWorkspaceAppRepository(
  repository: WorkspaceAppLike["repository"]
): WorkspaceAppCenterApp["repository"] {
  return repository?.type === "github" && typeof repository.url === "string"
    ? {
        type: "github",
        url: repository.url
      }
    : null;
}

function normalizeWorkspaceAppInstallProgress(
  progress: WorkspaceAppLike["installProgress"]
): WorkspaceAppCenterApp["installProgress"] {
  if (!isWorkspaceAppInstallProgressLike(progress)) {
    return null;
  }
  return {
    downloadedBytes: normalizeOptionalProgressNumber(progress.downloadedBytes),
    indeterminate: progress.indeterminate,
    overallPercent: progress.overallPercent,
    totalBytes: normalizeOptionalProgressNumber(progress.totalBytes),
    userPhase: progress.userPhase
  };
}

function isWorkspaceAppInstallProgressLike(
  value: WorkspaceAppLike["installProgress"]
): value is NonNullable<WorkspaceApp["installProgress"]> {
  if (value == null || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    isWorkspaceAppInstallUserPhase(candidate.userPhase) &&
    typeof candidate.overallPercent === "number" &&
    Number.isFinite(candidate.overallPercent) &&
    typeof candidate.indeterminate === "boolean" &&
    isOptionalProgressNumber(candidate.downloadedBytes) &&
    isOptionalProgressNumber(candidate.totalBytes)
  );
}

function isWorkspaceAppInstallUserPhase(
  value: unknown
): value is NonNullable<WorkspaceApp["installProgress"]>["userPhase"] {
  return (
    value === "downloading" || value === "installing" || value === "starting"
  );
}

function isOptionalProgressNumber(value: unknown): value is number | null {
  return value == null || (typeof value === "number" && Number.isFinite(value));
}

function normalizeOptionalProgressNumber(value: number | null | undefined) {
  return typeof value === "number" ? value : null;
}

function normalizeWorkspaceAppWindowMinimum(
  value: number | null | undefined
): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : null;
}

function normalizeWorkspaceAppCliState(
  cli: WorkspaceAppLike["cli"] | undefined
): WorkspaceAppCenterApp["cli"] {
  return {
    active: cli?.active ?? false,
    issues: (cli?.issues ?? []).map((issue) => ({
      code: issue.code,
      message: issue.message,
      path: issue.path
    })),
    scope: cli?.scope,
    status: cli?.status ?? "none"
  };
}

function normalizeWorkspaceAppLocalization(
  localization: WorkspaceAppLocalizationLike
): WorkspaceAppCenterLocalization {
  return {
    description: localization.description,
    locale: localization.locale,
    name: localization.displayName,
    tags: localization.tags ?? []
  };
}

function normalizeWorkspaceAppCenterSource(
  source: WorkspaceAppLike["source"]
): WorkspaceAppCenterSource {
  switch (source) {
    case "builtin":
      return "builtin";
    case "generated":
      return "generated";
    case "imported":
      return "imported";
    case "local-dev":
      return "local-dev";
    default:
      return assertNever(source, "Unsupported workspace app source");
  }
}

function normalizeRuntimeStatus(
  status: unknown
): WorkspaceAppCenterRuntimeStatus {
  return mapWorkspaceAppRuntimeStatus(status);
}

function assertNever(value: never, message: string): never {
  throw new Error(`${message}: ${String(value)}`);
}
