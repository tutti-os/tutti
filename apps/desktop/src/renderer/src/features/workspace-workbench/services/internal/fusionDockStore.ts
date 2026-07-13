import { proxy } from "valtio";
import type {
  DesktopFusionState,
  DesktopFusionWindowDescriptor
} from "@shared/contracts/fusion.ts";
import type { FusionBackgroundResource } from "../fusionDockResourceModel.ts";
import type { PendingFusionTerminalStop } from "../fusionDockService.interface.ts";

export interface FusionDockStoreState {
  actionError: boolean;
  fusionState: DesktopFusionState;
  pendingTerminalStop: PendingFusionTerminalStop | null;
  refreshing: boolean;
  resources: FusionBackgroundResource[];
  windows: DesktopFusionWindowDescriptor[];
  workspaceNameById: Record<string, string>;
}

export const initialFusionDockState: DesktopFusionState = {
  active: true,
  dockSearchExpanded: false,
  dockSearchScope: "all",
  dockVisible: false,
  revision: 0,
  shortcut: { binding: null, error: null },
  windows: [],
  workspaceId: null
};

export function createFusionDockStore(): FusionDockStoreState {
  return proxy({
    actionError: false,
    fusionState: initialFusionDockState,
    pendingTerminalStop: null,
    refreshing: false,
    resources: [],
    windows: [],
    workspaceNameById: {}
  });
}
