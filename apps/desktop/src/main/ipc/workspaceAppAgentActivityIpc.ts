import { randomUUID } from "node:crypto";
import { desktopIpcChannels } from "../../shared/contracts/ipc.ts";
import {
  normalizeTuttiExternalAgentActivityActivateSessionInput,
  normalizeTuttiExternalAgentActivityCancelTurnInput,
  normalizeTuttiExternalAgentActivityComposerOptionsInput,
  normalizeTuttiExternalAgentActivitySendInput
} from "@tutti-os/workspace-external-core/core";
import type {
  TuttiExternalAgentActivityActivateSessionResult,
  TuttiExternalAgentActivityCancelTurnResult,
  TuttiExternalAgentActivityComposerOptions,
  TuttiExternalAgentActivitySendResult,
  TuttiExternalAgentActivitySnapshot,
  TuttiExternalAgentTargetCatalog
} from "@tutti-os/workspace-external-core/contracts";
import type { DesktopLogger } from "../logging";
import type { DesktopDaemonEndpoint } from "../transport/paths";
import { registerDesktopIpcHandler } from "./handle.ts";
import { reportWorkspaceAppUserActive } from "./workspaceAppActivityAnalytics.ts";
import { requireWorkspaceAppGuestContext } from "./workspaceAppGuestContextRegistry.ts";
import { requestWorkspaceAppExternalRenderer } from "./workspaceAppRendererBridge.ts";

export function registerWorkspaceAppAgentActivityIpc(input: {
  endpoint: DesktopDaemonEndpoint;
  logger?: DesktopLogger;
}): void {
  const { endpoint, logger } = input;
  registerDesktopIpcHandler(
    desktopIpcChannels.appExternal.activityReportActive,
    async (event) => {
      const context = requireWorkspaceAppGuestContext(event.sender);
      try {
        await reportWorkspaceAppUserActive(endpoint, context);
      } catch (error: unknown) {
        logger?.warn("workspace app user active analytics failed", {
          appId: context.appID,
          error: error instanceof Error ? error.message : String(error),
          workspaceId: context.workspaceID
        });
      }
    }
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.appExternal.agentActivityActivateSession,
    async (event, payload) => {
      const context = requireWorkspaceAppGuestContext(event.sender);
      const activityInput =
        normalizeTuttiExternalAgentActivityActivateSessionInput(payload);
      return requestWorkspaceAppExternalRenderer<TuttiExternalAgentActivityActivateSessionResult>(
        context,
        {
          appId: context.appID,
          input: activityInput,
          operation: "agentActivity.activateSession",
          requestId: randomUUID(),
          workspaceId: context.workspaceID
        }
      );
    }
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.appExternal.agentActivityCancelTurn,
    async (event, payload) => {
      const context = requireWorkspaceAppGuestContext(event.sender);
      const activityInput =
        normalizeTuttiExternalAgentActivityCancelTurnInput(payload);
      return requestWorkspaceAppExternalRenderer<TuttiExternalAgentActivityCancelTurnResult>(
        context,
        {
          appId: context.appID,
          input: activityInput,
          operation: "agentActivity.cancelTurn",
          requestId: randomUUID(),
          workspaceId: context.workspaceID
        }
      );
    }
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.appExternal.agentActivityGetComposerOptions,
    async (event, payload) => {
      const context = requireWorkspaceAppGuestContext(event.sender);
      const activityInput =
        normalizeTuttiExternalAgentActivityComposerOptionsInput(payload);
      return requestWorkspaceAppExternalRenderer<TuttiExternalAgentActivityComposerOptions>(
        context,
        {
          appId: context.appID,
          input: activityInput,
          operation: "agentActivity.getComposerOptions",
          requestId: randomUUID(),
          workspaceId: context.workspaceID
        }
      );
    }
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.appExternal.agentActivityGetSnapshot,
    (event) => {
      const context = requireWorkspaceAppGuestContext(event.sender);
      return requestWorkspaceAppExternalRenderer<TuttiExternalAgentActivitySnapshot>(
        context,
        {
          appId: context.appID,
          operation: "agentActivity.getSnapshot",
          requestId: randomUUID(),
          workspaceId: context.workspaceID
        }
      );
    }
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.appExternal.agentActivityListTargets,
    (event) => {
      const context = requireWorkspaceAppGuestContext(event.sender);
      return requestWorkspaceAppExternalRenderer<TuttiExternalAgentTargetCatalog>(
        context,
        {
          appId: context.appID,
          operation: "agentActivity.listTargets",
          requestId: randomUUID(),
          workspaceId: context.workspaceID
        }
      );
    }
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.appExternal.agentActivitySendInput,
    async (event, payload) => {
      const context = requireWorkspaceAppGuestContext(event.sender);
      const activityInput =
        normalizeTuttiExternalAgentActivitySendInput(payload);
      return requestWorkspaceAppExternalRenderer<TuttiExternalAgentActivitySendResult>(
        context,
        {
          appId: context.appID,
          input: activityInput,
          operation: "agentActivity.sendInput",
          requestId: randomUUID(),
          workspaceId: context.workspaceID
        }
      );
    }
  );
}
