import type { WorkspaceAppCenterViewState } from "@tutti-os/workspace-app-center";

export function openWorkspaceAppTab(
  state: WorkspaceAppCenterViewState,
  appId: string
): WorkspaceAppCenterViewState {
  const normalizedAppId = appId.trim();
  if (!normalizedAppId) {
    return state;
  }
  const openAppIds = readWorkspaceAppTabIds(state);
  return {
    ...state,
    openAppId: normalizedAppId,
    openAppIds: openAppIds.includes(normalizedAppId)
      ? openAppIds
      : [...openAppIds, normalizedAppId]
  };
}

export function closeWorkspaceAppTab(
  state: WorkspaceAppCenterViewState,
  appId: string
): WorkspaceAppCenterViewState {
  const normalizedAppId = appId.trim();
  const openAppIds = readWorkspaceAppTabIds(state);
  const tabIndex = openAppIds.indexOf(normalizedAppId);
  if (tabIndex === -1) {
    return state;
  }
  const nextOpenAppIds = openAppIds.filter(
    (candidate) => candidate !== normalizedAppId
  );
  const activeAppId = state.openAppId?.trim() || null;
  return {
    ...state,
    openAppId:
      activeAppId === normalizedAppId
        ? (nextOpenAppIds[Math.min(tabIndex, nextOpenAppIds.length - 1)] ??
          null)
        : activeAppId,
    openAppIds: nextOpenAppIds
  };
}

export function selectWorkspaceAppTab(
  state: WorkspaceAppCenterViewState,
  appId: string | null
): WorkspaceAppCenterViewState {
  if (appId === null) {
    return state.openAppId == null ? state : { ...state, openAppId: null };
  }
  return openWorkspaceAppTab(state, appId);
}

export function readWorkspaceAppTabIds(
  state: WorkspaceAppCenterViewState
): string[] {
  const appIds: string[] = [];
  const seen = new Set<string>();
  for (const candidate of state.openAppIds ?? []) {
    const appId = candidate.trim();
    if (!appId || seen.has(appId)) {
      continue;
    }
    seen.add(appId);
    appIds.push(appId);
  }
  const activeAppId = state.openAppId?.trim() || null;
  if (activeAppId && !seen.has(activeAppId)) {
    appIds.push(activeAppId);
  }
  return appIds;
}
