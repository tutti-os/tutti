import type { WorkspaceAppCenterApp } from "@tutti-os/workspace-app-center";

export interface DesktopWorkspaceAppIconEntry {
  appId: string;
  iconUrl: string;
  workspaceId: string;
}

type DesktopWorkspaceAppIconSource = Pick<
  WorkspaceAppCenterApp,
  "appId" | "availableIconUrl" | "iconUrl"
>;

export function resolveDesktopWorkspaceAppIconEntries(input: {
  apps: readonly DesktopWorkspaceAppIconSource[];
  workspaceId: string;
}): DesktopWorkspaceAppIconEntry[] {
  const entriesByKey = new Map<string, DesktopWorkspaceAppIconEntry>();
  for (const app of input.apps) {
    addWorkspaceAppIconEntry(entriesByKey, {
      appId: app.appId,
      iconUrl: app.iconUrl ?? app.availableIconUrl ?? null,
      workspaceId: input.workspaceId
    });
  }
  return [...entriesByKey.values()];
}

function addWorkspaceAppIconEntry(
  entriesByKey: Map<string, DesktopWorkspaceAppIconEntry>,
  input: {
    appId: string | null | undefined;
    iconUrl: string | null | undefined;
    workspaceId: string;
  }
): void {
  const appId = input.appId?.trim() ?? "";
  const iconUrl = input.iconUrl?.trim() ?? "";
  if (!appId || !iconUrl) {
    return;
  }
  entriesByKey.set(`${input.workspaceId}\u0000${appId}`, {
    appId,
    iconUrl,
    workspaceId: input.workspaceId
  });
}
