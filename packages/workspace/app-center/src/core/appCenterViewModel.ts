import type {
  WorkspaceAppCatalogEntry,
  WorkspaceAppCatalogSourceKind,
  WorkspaceAppCatalogLocalization,
  WorkspaceAppInstallRecord,
  WorkspaceAppRecord
} from "../contracts/catalog.ts";
import type {
  AppCenterViewModel,
  WorkspaceAppFactoryEditAction,
  WorkspaceAppFactoryJobStatus,
  WorkspaceAppFactoryJobViewModel,
  WorkspaceAppPrimaryAction
} from "../contracts/viewModel.ts";
import type { WorkspaceAppRuntimeState } from "../contracts/runtime.ts";
import { mapWorkspaceAppRuntimeStatus } from "./statusMapping.ts";
import { resolveWorkspaceAppStatusPresentation } from "./statusMapping.ts";

export interface CreateAppCenterViewModelInput {
  readonly apps: readonly WorkspaceAppRecord[];
  readonly factoryJobs?: readonly WorkspaceAppFactoryJobInput[];
  readonly locale?: string | null;
  readonly replaceableIconAppIds?: readonly string[];
  readonly runtimeStates?: readonly WorkspaceAppRuntimeState[];
}

export interface WorkspaceAppFactoryJobInput {
  readonly agentTargetId?: string | null;
  readonly agentSessionId?: string | null;
  readonly appId?: string | null;
  readonly displayName: string;
  readonly failureReason?: string | null;
  readonly jobId: string;
  readonly prompt: string;
  readonly provider?: string | null;
  readonly publishedVersion?: string | null;
  readonly status: WorkspaceAppFactoryJobStatus;
  readonly updatedAtUnixMs: number;
  readonly validationResult?: Record<string, unknown> | null;
}

export function createAppCenterViewModel({
  apps,
  factoryJobs = [],
  locale = null,
  replaceableIconAppIds = [],
  runtimeStates = []
}: CreateAppCenterViewModelInput): AppCenterViewModel {
  const runtimeStateMaps = createRuntimeStateMaps(runtimeStates);
  const appFactoryJobByAppId = createAppFactoryJobByAppId(factoryJobs);
  const replaceableIconAppIdSet = new Set(
    replaceableIconAppIds.map((appId) => appId.trim()).filter(Boolean)
  );

  const appCards = apps
    .map((app) => {
      const installationId = normalizeOptionalString(
        app.install?.installationId
      );
      const runtime = findRuntimeStateForApp(
        runtimeStateMaps,
        app.manifest.appId,
        installationId
      );
      const factoryJob = appFactoryJobByAppId.get(app.manifest.appId);
      const metadata = resolveWorkspaceAppCatalogMetadata({
        catalog: app.catalog,
        locale,
        manifest: app.manifest
      });
      const factoryAgentSessionId = factoryJob?.agentSessionId?.trim() || null;
      const factoryEditAction: WorkspaceAppFactoryEditAction | null =
        factoryJob && factoryAgentSessionId
          ? factoryJob.status === "published"
            ? "prepare_modification"
            : "open_session"
          : null;
      const status = resolveRuntimeStatusForViewModel(runtime);
      const presentation = resolveWorkspaceAppStatusPresentation(status);
      const installed = Boolean(app.install);
      const installBusy =
        runtime?.installProgress != null || status === "installing";
      const sourceKind = resolveCatalogSourceKind(app.catalog);
      const localApp = sourceKind === "local";
      const localDevApp = app.catalog?.source?.kind === "local-dev";
      const runtimeId = normalizeOptionalString(runtime?.runtimeId);
      const launchUrl = normalizeOptionalString(runtime?.launchUrl);
      const installedVersion = normalizeOptionalString(app.install?.version);
      const manifestVersion = normalizeOptionalString(app.manifest.version);
      const displayVersion = installedVersion ?? manifestVersion;
      const comingSoon =
        isComingSoonApp(metadata.tags) ||
        isComingSoonApp(app.manifest.tags ?? []);
      const busy = isBusyRuntimeStatus(status);
      const unavailable = status === "unavailable";
      const canUpdate =
        !comingSoon &&
        !busy &&
        !unavailable &&
        installed &&
        (app.updateAvailable ?? false);
      const canOpen = !comingSoon && installed && canOpenInstalledApp(status);
      const canRestartAndOpen =
        !comingSoon && installed && status === "installed_pending_restart";
      const canRetry = installed && status === "failed";
      const primaryAction = resolvePrimaryAction({
        canOpen,
        canRetry,
        canRestartAndOpen,
        canUpdate,
        comingSoon,
        installed,
        status
      });

      const iconUrl = resolveWorkspaceAppIconUrl(app);

      return {
        id: app.manifest.appId,
        installationId,
        runtimeId,
        launchUrl,
        name: metadata.name,
        createdAtUnixMs: app.createdAtUnixMs ?? null,
        ...(metadata.description ? { description: metadata.description } : {}),
        ...(displayVersion && !comingSoon ? { version: displayVersion } : {}),
        ...(app.availableVersion && !comingSoon
          ? { availableVersion: app.availableVersion }
          : {}),
        ...(app.category?.trim() ? { category: app.category.trim() } : {}),
        updateAvailable: app.updateAvailable ?? false,
        ...(iconUrl
          ? {
              icon: {
                type: "asset" as const,
                src: iconUrl
              }
            }
          : {}),
        tags: metadata.tags,
        installed,
        status,
        statusLabelKey: comingSoon
          ? "status.comingSoon"
          : resolvePrimaryActionLabelKey(primaryAction, presentation.labelKey),
        statusTone: presentation.tone,
        statusPulse: runtime?.installProgress ? false : presentation.pulse,
        primaryAction,
        sourceKind,
        canOpen,
        canExport: localApp && !localDevApp,
        canDelete: localApp,
        canReloadLocal: localDevApp && installed && !installBusy,
        canReplaceIcon:
          !localDevApp && replaceableIconAppIdSet.has(app.manifest.appId),
        canOpenFolder: installed && !installBusy,
        canOpenPackageFolder:
          installed &&
          localApp &&
          (localDevApp || Boolean(displayVersion)) &&
          !installBusy,
        canOpenFactorySession: Boolean(factoryAgentSessionId),
        canPublishFactoryUpdate:
          installed &&
          factoryJob?.status === "ready" &&
          Boolean(factoryJob.publishedVersion?.trim()),
        canUninstall: installed && !installBusy,
        canRetry,
        canUpdate,
        ...(factoryJob?.agentTargetId
          ? { factoryAgentTargetId: factoryJob.agentTargetId }
          : {}),
        ...(factoryAgentSessionId ? { factoryAgentSessionId } : {}),
        ...(factoryEditAction ? { factoryEditAction } : {}),
        ...(factoryJob?.jobId ? { factoryJobId: factoryJob.jobId } : {}),
        ...(factoryJob?.provider
          ? { factoryProvider: factoryJob.provider }
          : {}),
        ...(runtime?.error?.message
          ? { errorMessage: runtime.error.message }
          : {}),
        ...(runtime?.installProgress
          ? { installProgress: runtime.installProgress }
          : {}),
        authors: resolveWorkspaceAppAuthors(app.manifest),
        ...(app.manifest.source
          ? {
              repository: {
                type: app.manifest.source.type,
                url: app.manifest.source.url
              }
            }
          : {})
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));

  return {
    apps: appCards,
    factoryJobs: factoryJobs
      .filter((job) => !isPublishedAppFactoryJob(job))
      .map(createFactoryJobViewModel),
    empty: appCards.length === 0,
    failedCount: appCards.filter((app) => app.status === "failed").length,
    installedCount: appCards.filter((app) => app.installed).length,
    runningCount: appCards.filter((app) => app.status === "running").length
  };
}

function resolveWorkspaceAppAuthors(manifest: WorkspaceAppRecord["manifest"]) {
  const authors =
    manifest.authors && manifest.authors.length > 0
      ? manifest.authors
      : manifest.author
        ? [manifest.author]
        : [];
  return authors
    .map((author) => ({
      avatarUrl: normalizeOptionalString(author.avatarUrl),
      name: normalizeOptionalString(author.name) ?? "",
      url: normalizeOptionalString(author.url)
    }))
    .filter((author) => author.name);
}

interface WorkspaceAppRuntimeStateMaps {
  readonly fallbackByAppId: Map<string, WorkspaceAppRuntimeState>;
  readonly byInstallationId: Map<string, WorkspaceAppRuntimeState>;
}

function createRuntimeStateMaps(
  runtimeStates: readonly WorkspaceAppRuntimeState[]
): WorkspaceAppRuntimeStateMaps {
  const fallbackByAppId = new Map<string, WorkspaceAppRuntimeState>();
  const byInstallationId = new Map<string, WorkspaceAppRuntimeState>();

  for (const state of runtimeStates) {
    const runtime = {
      ...state,
      status: mapWorkspaceAppRuntimeStatus(state.status),
      installProgress: state.installProgress ?? null
    };
    const installationId = normalizeOptionalString(runtime.installationId);
    if (installationId) {
      byInstallationId.set(installationId, runtime);
      continue;
    }

    const appId = normalizeOptionalString(runtime.appId);
    if (appId) {
      fallbackByAppId.set(appId, runtime);
    }
  }

  return {
    fallbackByAppId,
    byInstallationId
  };
}

function findRuntimeStateForApp(
  maps: WorkspaceAppRuntimeStateMaps,
  appId: string,
  installationId: string | null
): WorkspaceAppRuntimeState | undefined {
  if (installationId) {
    const runtime = maps.byInstallationId.get(installationId);
    if (runtime) {
      return runtime;
    }
  }

  return maps.fallbackByAppId.get(appId);
}

function resolveRuntimeStatusForViewModel(
  runtime: WorkspaceAppRuntimeState | undefined
): WorkspaceAppRuntimeState["status"] {
  if (!runtime) {
    return "idle";
  }
  if (runtime.installProgress != null && runtime.status === "idle") {
    return "installing";
  }
  return runtime.status;
}

function resolveCatalogSourceKind(
  catalog: WorkspaceAppCatalogEntry | null | undefined
): WorkspaceAppCatalogSourceKind {
  return catalog?.source?.kind === "local-dev"
    ? "local"
    : (catalog?.source?.kind ?? "bundled");
}

export function resolveWorkspaceAppCatalogMetadata(input: {
  readonly catalog?: Pick<WorkspaceAppCatalogEntry, "localizations"> | null;
  readonly locale?: string | null;
  readonly manifest: Pick<
    WorkspaceAppRecord["manifest"],
    "description" | "name" | "tags"
  >;
}): {
  readonly description: string;
  readonly name: string;
  readonly tags: readonly string[];
} {
  const manifest = input.manifest;
  const localization = findWorkspaceAppCatalogLocalization(
    input.catalog,
    input.locale
  );
  const name = localization?.name?.trim() || manifest.name;
  const description =
    localization?.description?.trim() || manifest.description || "";
  const tags =
    localization?.tags
      ?.map((tag) => tag.trim())
      .filter((tag) => tag.length > 0) ??
    manifest.tags ??
    [];
  return {
    description,
    name,
    tags: Array.from(new Set(tags))
  };
}

function findWorkspaceAppCatalogLocalization(
  catalog: Pick<WorkspaceAppCatalogEntry, "localizations"> | null | undefined,
  locale: string | null | undefined
): WorkspaceAppCatalogLocalization | null {
  const localizations = catalog?.localizations ?? [];
  const normalizedLocale = normalizeLocale(locale);
  if (!normalizedLocale || localizations.length === 0) {
    return null;
  }

  const exact = localizations.find(
    (localization) => normalizeLocale(localization.locale) === normalizedLocale
  );
  if (exact) {
    return exact;
  }

  const language = normalizedLocale.split("-")[0];
  if (!language) {
    return null;
  }
  return (
    localizations.find(
      (localization) =>
        normalizeLocale(localization.locale)?.split("-")[0] === language
    ) ?? null
  );
}

function normalizeLocale(value: string | null | undefined): string | null {
  const normalized = value?.trim().replace(/_/gu, "-").toLowerCase() ?? "";
  return normalized.length > 0 ? normalized : null;
}

function normalizeOptionalString(
  value: string | null | undefined
): string | null {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}

function resolveWorkspaceAppIconUrl(app: WorkspaceAppRecord): string | null {
  const manifestIconUrl = normalizeOptionalString(app.manifest.icon?.src);
  if (manifestIconUrl && isResolvedIconUrl(manifestIconUrl)) {
    return manifestIconUrl;
  }
  return normalizeOptionalString(app.availableIconUrl) ?? manifestIconUrl;
}

function isResolvedIconUrl(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/iu.test(value) || value.startsWith("/");
}

function resolvePrimaryAction(input: {
  readonly canOpen: boolean;
  readonly canRetry: boolean;
  readonly canRestartAndOpen: boolean;
  readonly canUpdate: boolean;
  readonly comingSoon: boolean;
  readonly installed: boolean;
  readonly status: WorkspaceAppRuntimeState["status"];
}): WorkspaceAppPrimaryAction {
  if (input.comingSoon) {
    return "none";
  }
  if (isBusyRuntimeStatus(input.status)) {
    return "none";
  }
  if (input.status === "unavailable") {
    return "none";
  }
  if (!input.installed) {
    return "install";
  }
  if (input.canUpdate) {
    return "update";
  }
  if (input.canRestartAndOpen) {
    return "restartAndOpen";
  }
  if (input.canRetry) {
    return "retry";
  }
  if (input.canOpen) {
    return "open";
  }
  return "none";
}

function isComingSoonApp(tags: readonly string[]): boolean {
  return tags.some((tag) => tag.trim().toLowerCase() === "coming-soon");
}

function canOpenInstalledApp(
  status: WorkspaceAppRuntimeState["status"]
): boolean {
  return status === "idle" || status === "running";
}

function isBusyRuntimeStatus(
  status: WorkspaceAppRuntimeState["status"]
): boolean {
  return (
    status === "installing" ||
    status === "preparing" ||
    status === "starting" ||
    status === "stopping"
  );
}

function resolvePrimaryActionLabelKey(
  primaryAction: WorkspaceAppPrimaryAction,
  fallbackLabelKey: string
): string {
  switch (primaryAction) {
    case "install":
      return "actions.installApp";
    case "open":
      return "actions.openApp";
    case "restartAndOpen":
      return "status.installedPendingRestart";
    case "retry":
      return "actions.retryApp";
    case "update":
      return "actions.updateApp";
    case "none":
      return fallbackLabelKey;
  }
}

function createAppFactoryJobByAppId(
  factoryJobs: readonly WorkspaceAppFactoryJobInput[]
): Map<string, WorkspaceAppFactoryJobInput> {
  const result = new Map<string, WorkspaceAppFactoryJobInput>();
  for (const job of [...factoryJobs].sort(
    (left, right) => right.updatedAtUnixMs - left.updatedAtUnixMs
  )) {
    if (!isPublishedAppFactoryJob(job)) {
      continue;
    }
    const appId = job.appId?.trim();
    if (!appId || result.has(appId)) {
      continue;
    }
    result.set(appId, job);
  }
  return result;
}

function isPublishedAppFactoryJob(job: WorkspaceAppFactoryJobInput): boolean {
  return job.status === "published" || Boolean(job.publishedVersion?.trim());
}

function createFactoryJobViewModel(
  job: WorkspaceAppFactoryJobInput
): WorkspaceAppFactoryJobViewModel {
  const statusLabelKey = `factory.status.${job.status}`;
  const title = job.displayName.trim();
  const agentSessionId = job.agentSessionId?.trim() || null;
  const canFixValidationFailure =
    job.status === "failed" && job.validationResult != null;
  return {
    id: job.jobId,
    agentTargetId: job.agentTargetId,
    agentSessionId,
    appId: job.appId,
    title,
    prompt: job.prompt,
    provider: job.provider,
    status: job.status,
    statusLabelKey,
    canCancel:
      job.status === "queued" ||
      job.status === "generating" ||
      job.status === "preparing" ||
      job.status === "validating",
    canDelete:
      job.status === "canceled" ||
      job.status === "failed" ||
      job.status === "published" ||
      job.status === "ready",
    canFix: canFixValidationFailure,
    canOpenAgentSession: Boolean(agentSessionId),
    canPublish: job.status === "ready",
    canRetryValidation: false,
    failureReason: job.failureReason,
    updatedAtUnixMs: job.updatedAtUnixMs
  };
}

export function createWorkspaceAppRecord(input: {
  readonly catalog?: WorkspaceAppCatalogEntry | null;
  readonly category?: string | null;
  readonly createdAtUnixMs?: number | null;
  readonly install?: WorkspaceAppInstallRecord | null;
}): WorkspaceAppRecord {
  const manifest = input.catalog?.manifest;
  if (!manifest) {
    throw new Error("catalog manifest is required.");
  }

  return {
    catalog: input.catalog,
    category: input.category,
    createdAtUnixMs: input.createdAtUnixMs ?? null,
    install: input.install ?? null,
    manifest
  };
}
