import {
  orderWorkbenchDockEntries,
  resolveWorkbenchHostDockEntries,
  type WorkbenchContribution,
  type WorkbenchHostDockEntry
} from "@tutti-os/workbench-surface/dock-catalog";
import { workspaceFilesNodeID } from "./workspaceWorkbenchNodeIds.ts";

const workspaceDockRetentionActionPrefix =
  "temporary-workspace-app-dock-retention:";
const workspaceAppDockEntryPrefix = "workspace-app:";
// This is the stable public id owned by @tutti-os/workbench-launchpad. Keeping
// the product catalog independent of its React entrypoint makes this model safe
// to consume from non-React launcher surfaces and Node tests.
const workspaceLaunchpadDockEntryId = "workspace-launchpad";

export interface WorkspaceDockLauncherCatalogInput {
  contributions?: readonly WorkbenchContribution[];
  dockEntries?: readonly WorkbenchHostDockEntry[];
  isWorkspaceAppInstalled?: (appId: string) => boolean | null | undefined;
  retainedByEntryId?: Readonly<Record<string, boolean | undefined>>;
}

/**
 * Resolves the product launcher catalog shared by the legacy Workbench Dock and
 * Fusion launch surfaces. Explicit entries replace contribution entries with
 * the same id before product retention policy and canonical ordering apply.
 */
export function resolveWorkspaceDockLauncherCatalog(
  input: WorkspaceDockLauncherCatalogInput
): WorkbenchHostDockEntry[] {
  const mergedEntries = resolveWorkbenchHostDockEntries({
    contributions: input.contributions,
    dockEntries: input.dockEntries
  });

  return orderWorkbenchDockEntries(
    mergedEntries.map((entry) =>
      resolveWorkspaceDockLauncherCatalogEntry({
        entry,
        isWorkspaceAppInstalled: input.isWorkspaceAppInstalled,
        retainedByEntryId: input.retainedByEntryId
      })
    )
  );
}

export function findWorkspaceDockLauncherCatalogEntry(
  entries: readonly WorkbenchHostDockEntry[],
  entryId: string
): WorkbenchHostDockEntry | null {
  return entries.find((entry) => entry.id === entryId) ?? null;
}

export function createWorkspaceDockRetentionActionId(entryId: string): string {
  return `${workspaceDockRetentionActionPrefix}${encodeURIComponent(entryId)}`;
}

export function readWorkspaceDockRetentionActionEntryId(
  actionId: string
): string | null {
  if (!actionId.startsWith(workspaceDockRetentionActionPrefix)) {
    return null;
  }
  const encodedEntryId = actionId.slice(
    workspaceDockRetentionActionPrefix.length
  );
  if (!encodedEntryId) {
    return null;
  }
  try {
    return decodeURIComponent(encodedEntryId) || null;
  } catch {
    return null;
  }
}

function resolveWorkspaceDockLauncherCatalogEntry(input: {
  entry: WorkbenchHostDockEntry;
  isWorkspaceAppInstalled?: (appId: string) => boolean | null | undefined;
  retainedByEntryId?: Readonly<Record<string, boolean | undefined>>;
}): WorkbenchHostDockEntry {
  const { entry } = input;
  if (
    entry.id === workspaceLaunchpadDockEntryId ||
    entry.id === workspaceFilesNodeID
  ) {
    return entry;
  }

  const appId = readWorkspaceAppIdFromDockEntryId(entry.id);
  const installed = appId ? input.isWorkspaceAppInstalled?.(appId) : undefined;
  const retained =
    input.retainedByEntryId?.[entry.id] ??
    entry.dockRetention?.retained ??
    installed ??
    (entry.visibility ?? "always") === "always";

  return {
    ...entry,
    dockRetention: {
      ...entry.dockRetention,
      actionId:
        entry.dockRetention?.actionId ??
        createWorkspaceDockRetentionActionId(entry.id),
      retained
    },
    visibility: retained ? "always" : "when-open"
  };
}

export function readWorkspaceAppIdFromDockEntryId(
  entryId: string
): string | null {
  if (!entryId.startsWith(workspaceAppDockEntryPrefix)) {
    return null;
  }
  const encodedAppId = entryId.slice(workspaceAppDockEntryPrefix.length);
  if (!encodedAppId) {
    return null;
  }
  try {
    return decodeURIComponent(encodedAppId) || null;
  } catch {
    return null;
  }
}
