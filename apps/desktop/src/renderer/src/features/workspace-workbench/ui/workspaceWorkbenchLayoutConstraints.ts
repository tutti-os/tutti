import type {
  WorkbenchDockPlacement,
  WorkbenchLayoutConstraintsInput
} from "@tutti-os/workbench-surface";

const workspaceWorkbenchTopSafeArea = 52;
const workspaceWorkbenchDockSafeArea = 65;
const workspaceWorkbenchDockSafetyGap = 14;
const workspaceWorkbenchBottomSafeArea =
  workspaceWorkbenchDockSafeArea + workspaceWorkbenchDockSafetyGap;
const workspaceWorkbenchLeftDockSafeArea = 80;

const workspaceWorkbenchAutoHideLayoutConstraints: WorkbenchLayoutConstraintsInput =
  {
    minWidth: 280,
    minHeight: 160,
    surfacePadding: 0,
    safeArea: {
      top: 0,
      right: 0,
      bottom: 0,
      left: 0
    }
  };

const workspaceWorkbenchBottomDockLayoutConstraints: WorkbenchLayoutConstraintsInput =
  {
    minWidth: 280,
    minHeight: 160,
    surfacePadding: 0,
    safeArea: {
      top: workspaceWorkbenchTopSafeArea,
      left: 0,
      bottom: workspaceWorkbenchBottomSafeArea
    }
  };

const workspaceWorkbenchLeftDockLayoutConstraints: WorkbenchLayoutConstraintsInput =
  {
    minWidth: 280,
    minHeight: 160,
    surfacePadding: 0,
    safeArea: {
      top: workspaceWorkbenchTopSafeArea,
      bottom: 0,
      left: workspaceWorkbenchLeftDockSafeArea
    }
  };

export function resolveWorkspaceWorkbenchLayoutConstraints(
  dockPlacement: WorkbenchDockPlacement,
  autoHideChrome = false
): WorkbenchLayoutConstraintsInput {
  if (autoHideChrome) {
    return workspaceWorkbenchAutoHideLayoutConstraints;
  }
  return dockPlacement === "left"
    ? workspaceWorkbenchLeftDockLayoutConstraints
    : workspaceWorkbenchBottomDockLayoutConstraints;
}
