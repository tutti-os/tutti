import { desktopIpcChannels } from "../../shared/contracts/ipc.ts";
import type { DesktopFusionWindowCoordinator } from "../windows/fusionWindowCoordinator.ts";
import { registerDesktopIpcHandler } from "./handle.ts";
import {
  assertFusionDockAccess,
  assertFusionOpenWindowAccess,
  assertFusionTargetWindowAccess,
  parseFusionOpenWindowInput,
  parseFusionUpdateWindowInput,
  parseFusionWindowTargetInput,
  requireFusionRendererAccess
} from "./fusionAccess.ts";

export function registerFusionIpc(
  fusion: DesktopFusionWindowCoordinator
): void {
  registerDesktopIpcHandler(desktopIpcChannels.fusion.getState, (event) => {
    const access = requireAccess(fusion, event.sender.id);
    return access.kind === "dock"
      ? fusion.getState()
      : fusion.getStateForWorkspace(access.workspaceId);
  });
  registerDesktopIpcHandler(desktopIpcChannels.fusion.showDock, (event) => {
    assertFusionDockAccess(requireAccess(fusion, event.sender.id));
    return fusion.showDock();
  });
  registerDesktopIpcHandler(desktopIpcChannels.fusion.hideDock, (event) => {
    assertFusionDockAccess(requireAccess(fusion, event.sender.id));
    return fusion.hideDock();
  });
  registerDesktopIpcHandler(desktopIpcChannels.fusion.toggleDock, (event) => {
    assertFusionDockAccess(requireAccess(fusion, event.sender.id));
    return fusion.toggleDock();
  });
  registerDesktopIpcHandler(
    desktopIpcChannels.fusion.openWindow,
    (event, rawInput) => {
      const access = requireAccess(fusion, event.sender.id);
      const input = parseFusionOpenWindowInput(rawInput);
      assertFusionOpenWindowAccess(access, input);
      return fusion.openWindow(input);
    }
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.fusion.focusWindow,
    (event, rawInput) => {
      const access = requireAccess(fusion, event.sender.id);
      const input = parseFusionWindowTargetInput(rawInput);
      assertFusionTargetWindowAccess(
        access,
        fusion.getWindowDescriptor(input.windowInstanceId)
      );
      return fusion.focusWindow(input);
    }
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.fusion.closeWindow,
    (event, rawInput) => {
      const access = requireAccess(fusion, event.sender.id);
      const input = parseFusionWindowTargetInput(rawInput);
      assertFusionTargetWindowAccess(
        access,
        fusion.getWindowDescriptor(input.windowInstanceId)
      );
      return fusion.closeWindow(input);
    }
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.fusion.updateWindow,
    (event, rawInput) => {
      const access = requireAccess(fusion, event.sender.id);
      const input = parseFusionUpdateWindowInput(rawInput);
      assertFusionTargetWindowAccess(
        access,
        fusion.getWindowDescriptor(input.windowInstanceId)
      );
      return fusion.updateWindow(input);
    }
  );
}

function requireAccess(
  fusion: DesktopFusionWindowCoordinator,
  webContentsId: number
) {
  return requireFusionRendererAccess(
    fusion.getRendererAccessContext(webContentsId)
  );
}
