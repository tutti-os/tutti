import type {
  WorkbenchHostDockEntry,
  WorkbenchHostDockEntryDynamicState
} from "@tutti-os/workbench-surface";
import { orderWorkbenchDockEntries } from "@tutti-os/workbench-surface/dock-catalog";
import type {
  DesktopFusionOpenWindowInput,
  DesktopFusionWindowDescriptor,
  DesktopFusionWindowKind
} from "@shared/contracts/fusion.ts";
import type { FusionBackgroundResource } from "./fusionDockResourceModel.ts";
import { resolveFusionKindForWorkbenchTypeId } from "./fusionWindowModel.ts";
import { readWorkspaceAppIdFromDockEntryId } from "./workspaceDockLauncherCatalog.ts";

export interface FusionDockLauncher {
  readonly entry: WorkbenchHostDockEntry;
  readonly kind: DesktopFusionWindowKind;
  readonly resourceId: string | null;
  readonly workspaceId: string;
}

export interface FusionDockLauncherInstanceCounts {
  readonly backgroundOnlyCount: number;
  readonly backgroundStatus: "failed" | "running" | "warning" | null;
  readonly totalCount: number;
  readonly windowCount: number;
}

export type FusionDockLauncherActivationTarget =
  | { readonly kind: "new" }
  | {
      readonly kind: "resource";
      readonly resource: FusionBackgroundResource;
    }
  | {
      readonly kind: "window";
      readonly window: DesktopFusionWindowDescriptor;
    };

export function resolveFusionDockLaunchers(input: {
  dockEntries: readonly WorkbenchHostDockEntry[];
  dynamicStateByEntryId?: Readonly<
    Record<string, WorkbenchHostDockEntryDynamicState | null | undefined>
  >;
  resources: readonly FusionBackgroundResource[];
  windows: readonly DesktopFusionWindowDescriptor[];
  workspaceId: string;
}): FusionDockLauncher[] {
  const renderedEntries = orderWorkbenchDockEntries(
    input.dockEntries.map((entry) =>
      mergeFusionDockLauncherEntryState(
        entry,
        input.dynamicStateByEntryId?.[entry.id]
      )
    )
  );
  return renderedEntries.flatMap((entry) => {
    const kind = resolveFusionKindForWorkbenchTypeId(entry.typeId);
    if (!kind) {
      return [];
    }
    const launcher: FusionDockLauncher = {
      entry,
      kind,
      resourceId:
        kind === "workspace-app"
          ? readWorkspaceAppIdFromDockEntryId(entry.id)
          : null,
      workspaceId: input.workspaceId
    };
    const visibility = entry.visibility ?? "always";
    if (
      visibility === "never" ||
      (visibility === "when-open" &&
        countFusionDockLauncherInstances({
          launcher,
          resources: input.resources,
          windows: input.windows
        }) === 0)
    ) {
      return [];
    }
    return [launcher];
  });
}

export function resolveFusionDockLauncherActivationTarget(input: {
  launcher: Pick<
    DesktopFusionOpenWindowInput,
    "kind" | "resourceId" | "workspaceId"
  >;
  resources: readonly FusionBackgroundResource[];
  windows: readonly DesktopFusionWindowDescriptor[];
}): FusionDockLauncherActivationTarget {
  const resourceId = input.launcher.resourceId?.trim() || null;
  const window = [...input.windows]
    .filter(
      (candidate) =>
        candidate.workspaceId === input.launcher.workspaceId &&
        candidate.kind === input.launcher.kind &&
        (resourceId === null || candidate.resourceId === resourceId)
    )
    .sort(
      (left, right) =>
        right.lastFocusedAtUnixMs - left.lastFocusedAtUnixMs ||
        right.createdAtUnixMs - left.createdAtUnixMs
    )[0];
  if (window) {
    return { kind: "window", window };
  }
  const resource = [...input.resources]
    .filter(
      (candidate) =>
        candidate.category === "background-task" &&
        candidate.workspaceId === input.launcher.workspaceId &&
        candidate.kind === input.launcher.kind &&
        (resourceId === null || candidate.id === resourceId)
    )
    .sort(
      (left, right) =>
        right.updatedAtUnixMs - left.updatedAtUnixMs ||
        left.title.localeCompare(right.title)
    )[0];
  return resource ? { kind: "resource", resource } : { kind: "new" };
}

export function countFusionDockLauncherInstances(input: {
  launcher: FusionDockLauncher;
  resources: readonly FusionBackgroundResource[];
  windows: readonly DesktopFusionWindowDescriptor[];
}): number {
  return projectFusionDockLauncherInstanceCounts(input).totalCount;
}

export function projectFusionDockLauncherInstanceCounts(input: {
  launcher: FusionDockLauncher;
  resources: readonly FusionBackgroundResource[];
  windows: readonly DesktopFusionWindowDescriptor[];
}): FusionDockLauncherInstanceCounts {
  const windowCount = input.windows.filter((window) =>
    matchesFusionDockLauncherWindow(input.launcher, window)
  ).length;
  const backgroundOnlyResources = input.resources.filter(
    (resource) =>
      resource.category === "background-task" &&
      resource.attachedWindowCount === 0 &&
      matchesFusionDockLauncherResource(input.launcher, resource)
  );
  const backgroundOnlyCount = backgroundOnlyResources.length;
  return {
    backgroundOnlyCount,
    backgroundStatus: resolveFusionDockBackgroundStatus(
      backgroundOnlyResources
    ),
    totalCount: windowCount + backgroundOnlyCount,
    windowCount
  };
}

function resolveFusionDockBackgroundStatus(
  resources: readonly FusionBackgroundResource[]
): FusionDockLauncherInstanceCounts["backgroundStatus"] {
  if (resources.length === 0) {
    return null;
  }
  if (
    resources.some(
      (resource) =>
        resource.status === "failed" || resource.status === "unavailable"
    )
  ) {
    return "failed";
  }
  if (
    resources.some(
      (resource) =>
        resource.status === "waiting" ||
        resource.status === "installed_pending_restart" ||
        resource.status === "stopping"
    )
  ) {
    return "warning";
  }
  return "running";
}

export function isFusionDockLauncherBlocked(
  launcher: FusionDockLauncher
): boolean {
  const state = launcher.entry.state?.kind ?? "enabled";
  return (
    launcher.entry.launchBehavior === "disabled" ||
    state === "disabled" ||
    state === "loading" ||
    state === "unavailable"
  );
}

export function matchesFusionDockLauncherWindow(
  launcher: FusionDockLauncher,
  window: DesktopFusionWindowDescriptor
): boolean {
  return (
    window.workspaceId === launcher.workspaceId &&
    window.kind === launcher.kind &&
    (launcher.resourceId === null || window.resourceId === launcher.resourceId)
  );
}

export function matchesFusionDockLauncherResource(
  launcher: FusionDockLauncher,
  resource: FusionBackgroundResource
): boolean {
  return (
    resource.workspaceId === launcher.workspaceId &&
    resource.kind === launcher.kind &&
    (launcher.resourceId === null || resource.id === launcher.resourceId)
  );
}

function mergeFusionDockLauncherEntryState(
  entry: WorkbenchHostDockEntry,
  dynamicState: WorkbenchHostDockEntryDynamicState | null | undefined
): WorkbenchHostDockEntry {
  return dynamicState ? { ...entry, ...dynamicState } : entry;
}
