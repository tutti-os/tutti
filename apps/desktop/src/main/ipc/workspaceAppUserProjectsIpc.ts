import { randomUUID } from "node:crypto";
import { desktopIpcChannels } from "../../shared/contracts/ipc.ts";
import {
  normalizeTuttiExternalUserProjectCreateInput,
  normalizeTuttiExternalUserProjectMoveInput,
  normalizeTuttiExternalUserProjectPathInput,
  normalizeTuttiExternalUserProjectRememberDefaultSelectionInput,
  normalizeTuttiExternalUserProjectSelectionPreparationInput
} from "@tutti-os/workspace-external-core/core";
import { registerDesktopIpcHandler } from "./handle.ts";
import { requireWorkspaceAppGuestContext } from "./workspaceAppGuestContextRegistry.ts";
import { requestWorkspaceAppExternalRenderer } from "./workspaceAppRendererBridge.ts";

export function registerWorkspaceAppUserProjectsIpc(): void {
  registerDesktopIpcHandler(
    desktopIpcChannels.appExternal.userProjectsCheckPath,
    async (event, payload) => {
      const context = requireWorkspaceAppGuestContext(event.sender);
      const input = normalizeTuttiExternalUserProjectPathInput(
        payload,
        "checkPath"
      );
      return requestWorkspaceAppExternalRenderer(context, {
        appId: context.appID,
        input,
        operation: "userProjects.checkPath",
        requestId: randomUUID(),
        workspaceId: context.workspaceID
      });
    }
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.appExternal.userProjectsCreate,
    async (event, payload) => {
      const context = requireWorkspaceAppGuestContext(event.sender);
      const input = normalizeTuttiExternalUserProjectCreateInput(payload);
      return requestWorkspaceAppExternalRenderer(context, {
        appId: context.appID,
        input,
        operation: "userProjects.create",
        requestId: randomUUID(),
        workspaceId: context.workspaceID
      });
    }
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.appExternal.userProjectsGetDefaultSelection,
    async (event) => {
      const context = requireWorkspaceAppGuestContext(event.sender);
      return requestWorkspaceAppExternalRenderer(context, {
        appId: context.appID,
        operation: "userProjects.getDefaultSelection",
        requestId: randomUUID(),
        workspaceId: context.workspaceID
      });
    }
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.appExternal.userProjectsGetSnapshot,
    async (event) => {
      const context = requireWorkspaceAppGuestContext(event.sender);
      return requestWorkspaceAppExternalRenderer(context, {
        appId: context.appID,
        operation: "userProjects.getSnapshot",
        requestId: randomUUID(),
        workspaceId: context.workspaceID
      });
    }
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.appExternal.userProjectsList,
    async (event) => {
      const context = requireWorkspaceAppGuestContext(event.sender);
      return requestWorkspaceAppExternalRenderer(context, {
        appId: context.appID,
        operation: "userProjects.list",
        requestId: randomUUID(),
        workspaceId: context.workspaceID
      });
    }
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.appExternal.userProjectsMove,
    async (event, payload) => {
      const context = requireWorkspaceAppGuestContext(event.sender);
      const input = normalizeTuttiExternalUserProjectMoveInput(payload);
      return requestWorkspaceAppExternalRenderer(context, {
        appId: context.appID,
        input,
        operation: "userProjects.move",
        requestId: randomUUID(),
        workspaceId: context.workspaceID
      });
    }
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.appExternal.userProjectsRemove,
    async (event, payload) => {
      const context = requireWorkspaceAppGuestContext(event.sender);
      const input = normalizeTuttiExternalUserProjectPathInput(
        payload,
        "remove"
      );
      return requestWorkspaceAppExternalRenderer<void>(context, {
        appId: context.appID,
        input,
        operation: "userProjects.remove",
        requestId: randomUUID(),
        workspaceId: context.workspaceID
      });
    }
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.appExternal.userProjectsPrepareSelection,
    async (event, payload) => {
      const context = requireWorkspaceAppGuestContext(event.sender);
      const input =
        normalizeTuttiExternalUserProjectSelectionPreparationInput(payload);
      return requestWorkspaceAppExternalRenderer(context, {
        appId: context.appID,
        input,
        operation: "userProjects.prepareSelection",
        requestId: randomUUID(),
        workspaceId: context.workspaceID
      });
    }
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.appExternal.userProjectsRefresh,
    async (event) => {
      const context = requireWorkspaceAppGuestContext(event.sender);
      return requestWorkspaceAppExternalRenderer(context, {
        appId: context.appID,
        operation: "userProjects.refresh",
        requestId: randomUUID(),
        workspaceId: context.workspaceID
      });
    }
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.appExternal.userProjectsRememberDefaultSelection,
    async (event, payload) => {
      const context = requireWorkspaceAppGuestContext(event.sender);
      const input =
        normalizeTuttiExternalUserProjectRememberDefaultSelectionInput(payload);
      return requestWorkspaceAppExternalRenderer(context, {
        appId: context.appID,
        input,
        operation: "userProjects.rememberDefaultSelection",
        requestId: randomUUID(),
        workspaceId: context.workspaceID
      });
    }
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.appExternal.userProjectsSelectDirectory,
    async (event) => {
      const context = requireWorkspaceAppGuestContext(event.sender);
      return requestWorkspaceAppExternalRenderer(context, {
        appId: context.appID,
        operation: "userProjects.selectDirectory",
        requestId: randomUUID(),
        workspaceId: context.workspaceID
      });
    }
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.appExternal.userProjectsUse,
    async (event, payload) => {
      const context = requireWorkspaceAppGuestContext(event.sender);
      const input = normalizeTuttiExternalUserProjectPathInput(payload, "use");
      return requestWorkspaceAppExternalRenderer(context, {
        appId: context.appID,
        input,
        operation: "userProjects.use",
        requestId: randomUUID(),
        workspaceId: context.workspaceID
      });
    }
  );
}
