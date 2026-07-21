import type {
  WorkspaceAppCenterApp,
  WorkspaceAppCenterViewState,
  WorkspaceAppFactoryJob
} from "../contracts/host.ts";

export function resolveAppRunDurationMs(
  startedAtUnixMs: number | null | undefined,
  now: number
) {
  if (
    typeof startedAtUnixMs !== "number" ||
    !Number.isFinite(startedAtUnixMs) ||
    startedAtUnixMs <= 0
  ) {
    return null;
  }

  return Math.max(0, now - startedAtUnixMs);
}

export function sortWorkspaceAppCenterApps(
  apps: readonly WorkspaceAppCenterApp[]
): WorkspaceAppCenterApp[] {
  return [...apps].sort((left, right) =>
    left.name.localeCompare(right.name, undefined, { sensitivity: "base" })
  );
}

export function mergeWorkspaceAppCatalogFields(
  currentApp: WorkspaceAppCenterApp,
  snapshotApp: WorkspaceAppCenterApp
): WorkspaceAppCenterApp {
  return {
    ...currentApp,
    availableIconUrl: snapshotApp.availableIconUrl,
    availableVersion: snapshotApp.availableVersion,
    description: snapshotApp.description,
    iconUrl: snapshotApp.iconUrl,
    localPackageDir: snapshotApp.localPackageDir,
    localizations: snapshotApp.localizations,
    minimizeBehavior: snapshotApp.minimizeBehavior,
    name: snapshotApp.name,
    references: snapshotApp.references,
    source: snapshotApp.source,
    tags: snapshotApp.tags,
    updateAvailable: snapshotApp.updateAvailable
  };
}

function areWorkspaceAppInstallProgressEqual(
  left: WorkspaceAppCenterApp["installProgress"],
  right: WorkspaceAppCenterApp["installProgress"]
): boolean {
  if (left == null && right == null) {
    return true;
  }
  if (left == null || right == null) {
    return false;
  }
  return (
    left.userPhase === right.userPhase &&
    left.overallPercent === right.overallPercent &&
    left.downloadedBytes === right.downloadedBytes &&
    left.totalBytes === right.totalBytes &&
    left.indeterminate === right.indeterminate
  );
}

export function areWorkspaceAppCenterAppsEqual(
  left: readonly WorkspaceAppCenterApp[],
  right: readonly WorkspaceAppCenterApp[]
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((leftApp, index) => {
    const rightApp = right[index];
    return (
      rightApp !== undefined &&
      leftApp.appId === rightApp.appId &&
      leftApp.availableIconUrl === rightApp.availableIconUrl &&
      leftApp.availableVersion === rightApp.availableVersion &&
      leftApp.createdAtUnixMs === rightApp.createdAtUnixMs &&
      leftApp.description === rightApp.description &&
      leftApp.enabled === rightApp.enabled &&
      leftApp.exportable === rightApp.exportable &&
      leftApp.iconUrl === rightApp.iconUrl &&
      leftApp.installed === rightApp.installed &&
      areWorkspaceAppInstallProgressEqual(
        leftApp.installProgress,
        rightApp.installProgress
      ) &&
      leftApp.installationId === rightApp.installationId &&
      leftApp.localPackageDir === rightApp.localPackageDir &&
      areWorkspaceAppCenterLocalizationsEqual(
        leftApp.localizations ?? [],
        rightApp.localizations ?? []
      ) &&
      leftApp.minimizeBehavior === rightApp.minimizeBehavior &&
      leftApp.name === rightApp.name &&
      leftApp.references.listSupported === rightApp.references.listSupported &&
      leftApp.runtimeId === rightApp.runtimeId &&
      leftApp.runtimeStatus === rightApp.runtimeStatus &&
      leftApp.source === rightApp.source &&
      leftApp.stateRevision === rightApp.stateRevision &&
      areStringArraysEqual(leftApp.tags ?? [], rightApp.tags ?? []) &&
      (leftApp.updateAvailable ?? false) ===
        (rightApp.updateAvailable ?? false) &&
      leftApp.launchUrl === rightApp.launchUrl &&
      leftApp.version === rightApp.version &&
      leftApp.windowMinHeight === rightApp.windowMinHeight &&
      leftApp.windowMinWidth === rightApp.windowMinWidth
    );
  });
}

export function normalizeWorkspaceAppCenterViewState(
  value: Partial<WorkspaceAppCenterViewState> | null | undefined
): WorkspaceAppCenterViewState {
  const activeAppTab =
    value?.activeAppTab === "community" || value?.activeAppTab === "my"
      ? value.activeAppTab
      : "recommended";
  const openAppId = value?.openAppId?.trim() || null;
  const openAppIds = normalizeWorkspaceAppIds(value?.openAppIds);
  if (openAppId && !openAppIds.includes(openAppId)) {
    openAppIds.push(openAppId);
  }
  return {
    activeAppTab,
    openAppId,
    openAppIds
  };
}

export function areWorkspaceAppCenterViewStatesEqual(
  left: WorkspaceAppCenterViewState,
  right: WorkspaceAppCenterViewState
): boolean {
  return (
    left.activeAppTab === right.activeAppTab &&
    (left.openAppId?.trim() || null) === (right.openAppId?.trim() || null) &&
    areStringArraysEqual(
      normalizeWorkspaceAppIds(left.openAppIds),
      normalizeWorkspaceAppIds(right.openAppIds)
    )
  );
}

function normalizeWorkspaceAppIds(
  values: readonly string[] | null | undefined
): string[] {
  const appIds: string[] = [];
  const seen = new Set<string>();
  for (const value of values ?? []) {
    const appId = value.trim();
    if (!appId || seen.has(appId)) {
      continue;
    }
    seen.add(appId);
    appIds.push(appId);
  }
  return appIds;
}

function areWorkspaceAppCenterLocalizationsEqual(
  left: NonNullable<WorkspaceAppCenterApp["localizations"]>,
  right: NonNullable<WorkspaceAppCenterApp["localizations"]>
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((leftLocalization, index) => {
    const rightLocalization = right[index];
    return (
      rightLocalization !== undefined &&
      leftLocalization.locale === rightLocalization.locale &&
      leftLocalization.name === rightLocalization.name &&
      leftLocalization.description === rightLocalization.description &&
      areStringArraysEqual(leftLocalization.tags, rightLocalization.tags)
    );
  });
}

function areStringArraysEqual(
  left: readonly string[],
  right: readonly string[]
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((value, index) => value === right[index]);
}

export function appRuntimeKey(workspaceId: string, appId: string): string {
  return `${workspaceId}\u0000${appId}`;
}

export function factoryJobKey(workspaceId: string, jobId: string): string {
  return `${workspaceId}\u0000${jobId}`;
}

export function removedOrUninstalledAppIds(
  previousApps: readonly WorkspaceAppCenterApp[],
  nextApps: readonly WorkspaceAppCenterApp[]
): string[] {
  const nextAppsById = new Map(nextApps.map((app) => [app.appId, app]));
  const appIds: string[] = [];
  for (const previousApp of previousApps) {
    if (!previousApp.installed) {
      continue;
    }
    const nextApp = nextAppsById.get(previousApp.appId);
    if (!nextApp?.installed) {
      appIds.push(previousApp.appId);
    }
  }
  return appIds;
}

export function sortWorkspaceAppFactoryJobs(
  jobs: readonly WorkspaceAppFactoryJob[]
): WorkspaceAppFactoryJob[] {
  return [...jobs].sort(
    (left, right) => right.updatedAtUnixMs - left.updatedAtUnixMs
  );
}

export function areWorkspaceAppFactoryJobsEqual(
  left: readonly WorkspaceAppFactoryJob[],
  right: readonly WorkspaceAppFactoryJob[]
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((leftJob, index) => {
    const rightJob = right[index];
    return (
      rightJob !== undefined &&
      leftJob.agentTargetId === rightJob.agentTargetId &&
      leftJob.agentSessionId === rightJob.agentSessionId &&
      leftJob.appId === rightJob.appId &&
      leftJob.createdAtUnixMs === rightJob.createdAtUnixMs &&
      leftJob.description === rightJob.description &&
      leftJob.displayName === rightJob.displayName &&
      leftJob.failureReason === rightJob.failureReason &&
      leftJob.jobId === rightJob.jobId &&
      leftJob.model === rightJob.model &&
      leftJob.prompt === rightJob.prompt &&
      leftJob.provider === rightJob.provider &&
      leftJob.publishedVersion === rightJob.publishedVersion &&
      leftJob.reasoningEffort === rightJob.reasoningEffort &&
      leftJob.status === rightJob.status &&
      leftJob.updatedAtUnixMs === rightJob.updatedAtUnixMs &&
      leftJob.workspaceId === rightJob.workspaceId
    );
  });
}

export function noop(): void {}
