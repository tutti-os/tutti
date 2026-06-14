import { proxy } from "valtio";
import type { WorkspaceAppCenterStoreState } from "@tutti-os/workspace-app-center";

export function createWorkspaceAppCenterStore(): WorkspaceAppCenterStoreState {
  return proxy({
    apps: [],
    catalogLastError: null,
    catalogStatus: "disabled",
    catalogUpdatedAtUnixMs: null,
    error: null,
    factoryJobs: [],
    loadStatus: "idle",
    openingFolderAppId: null,
    revision: 0,
    viewStateByWorkspaceId: {},
    workspaceId: null
  });
}
