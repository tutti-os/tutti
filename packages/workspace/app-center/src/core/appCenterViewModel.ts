import type {
  WorkspaceAppCatalogEntry,
  WorkspaceAppCatalogSourceKind,
  WorkspaceAppCatalogLocalization,
  WorkspaceAppInstallRecord,
  WorkspaceAppRecord
} from "../contracts/catalog.ts";
import type {
  AppCenterViewModel,
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
  const runtimeByAppId = new Map(
    runtimeStates.map((state) => [
      state.appId,
      {
        ...state,
        status: mapWorkspaceAppRuntimeStatus(state.status)
      }
    ])
  );
  const appFactoryJobByAppId = createAppFactoryJobByAppId(factoryJobs);
  const replaceableIconAppIdSet = new Set(
    replaceableIconAppIds.map((appId) => appId.trim()).filter(Boolean)
  );

  const appCards = apps
    .map((app) => {
      const runtime = runtimeByAppId.get(app.manifest.appId);
      const factoryJob = appFactoryJobByAppId.get(app.manifest.appId);
      const metadata = resolveWorkspaceAppCatalogMetadata({
        catalog: app.catalog,
        locale,
        manifest: app.manifest
      });
      const factoryAgentSessionId = factoryJob?.agentSessionId?.trim() || null;
      const status = runtime?.status ?? "idle";
      const presentation = resolveWorkspaceAppStatusPresentation(status);
      const installed = Boolean(app.install);
      const sourceKind = resolveCatalogSourceKind(app.catalog);
      const localApp = sourceKind === "local";
      const comingSoon =
        isComingSoonApp(metadata.tags) ||
        isComingSoonApp(app.manifest.tags ?? []);
      const busy = isBusyRuntimeStatus(status);
      const canUpdate =
        !comingSoon && !busy && installed && (app.updateAvailable ?? false);
      const canOpen = !comingSoon && installed && canOpenInstalledApp(status);
      const canRetry = installed && status === "failed";
      const primaryAction = resolvePrimaryAction({
        canOpen,
        canRetry,
        canUpdate,
        comingSoon,
        installed,
        status
      });

      return {
        id: app.manifest.appId,
        name: metadata.name,
        createdAtUnixMs: app.createdAtUnixMs ?? null,
        ...(metadata.description ? { description: metadata.description } : {}),
        ...(app.manifest.version && !comingSoon
          ? { version: app.manifest.version }
          : {}),
        ...(app.availableVersion && !comingSoon
          ? { availableVersion: app.availableVersion }
          : {}),
        ...(app.category?.trim() ? { category: app.category.trim() } : {}),
        updateAvailable: app.updateAvailable ?? false,
        ...(app.manifest.icon ? { icon: app.manifest.icon } : {}),
        tags: metadata.tags,
        installed,
        status,
        statusLabelKey: comingSoon
          ? "status.comingSoon"
          : resolvePrimaryActionLabelKey(primaryAction, presentation.labelKey),
        statusTone: presentation.tone,
        statusPulse: presentation.pulse,
        primaryAction,
        sourceKind,
        canOpen,
        canExport: localApp,
        canDelete: localApp,
        canReplaceIcon: replaceableIconAppIdSet.has(app.manifest.appId),
        canOpenFolder: installed,
        canOpenPackageFolder:
          installed && localApp && Boolean(app.manifest.version?.trim()),
        canOpenFactorySession: Boolean(factoryAgentSessionId),
        canPublishFactoryUpdate:
          installed &&
          factoryJob?.status === "ready" &&
          Boolean(factoryJob.publishedVersion?.trim()),
        canUninstall: installed,
        canRetry,
        canUpdate,
        ...(factoryAgentSessionId ? { factoryAgentSessionId } : {}),
        ...(factoryJob?.jobId ? { factoryJobId: factoryJob.jobId } : {}),
        ...(factoryJob?.provider
          ? { factoryProvider: factoryJob.provider }
          : {}),
        ...(runtime?.error?.message
          ? { errorMessage: runtime.error.message }
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

function resolveCatalogSourceKind(
  catalog: WorkspaceAppCatalogEntry | null | undefined
): WorkspaceAppCatalogSourceKind {
  return catalog?.source?.kind ?? "bundled";
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

function resolvePrimaryAction(input: {
  readonly canOpen: boolean;
  readonly canRetry: boolean;
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
  if (!input.installed) {
    return "install";
  }
  if (input.canUpdate) {
    return "update";
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
    canRetryValidation: canFixValidationFailure,
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
