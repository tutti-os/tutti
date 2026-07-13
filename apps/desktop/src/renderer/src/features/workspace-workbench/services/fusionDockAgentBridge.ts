import type { DesktopFusionApi } from "@preload/types";
import type { DesktopHostNotificationNavigationPayload } from "@shared/contracts/ipc.ts";
import type {
  AgentProviderStatusSnapshot,
  IAgentProviderStatusService
} from "@renderer/features/workspace-agent/services/agentProviderStatusService.interface.ts";
import type { IWorkspaceWorkbenchHostService } from "./workspaceWorkbenchHostService.interface.ts";

export function startFusionDockAgentBridge(input: {
  agentProviderStatusService: Pick<
    IAgentProviderStatusService,
    "getSnapshot" | "subscribe"
  >;
  fusionApi: DesktopFusionApi;
  onNavigationError?: (
    error: unknown,
    payload: DesktopHostNotificationNavigationPayload
  ) => void;
  workbenchHostService: Pick<
    IWorkspaceWorkbenchHostService,
    "broadcastAgentStatus" | "onNotificationNavigate"
  >;
}): () => void {
  const broadcastAgentStatus = () => {
    input.workbenchHostService.broadcastAgentStatus({
      agentBound: hasReadyAgentProvider(
        input.agentProviderStatusService.getSnapshot()
      )
    });
  };
  broadcastAgentStatus();
  const unsubscribeStatus =
    input.agentProviderStatusService.subscribe(broadcastAgentStatus);
  const unsubscribeNavigation =
    input.workbenchHostService.onNotificationNavigate((payload) => {
      void openFusionNotificationAgent({
        fusionApi: input.fusionApi,
        payload
      }).catch((error: unknown) => {
        input.onNavigationError?.(error, payload);
      });
    });
  return () => {
    unsubscribeNavigation();
    unsubscribeStatus();
  };
}

export function hasReadyAgentProvider(
  snapshot: Pick<AgentProviderStatusSnapshot, "statuses">
): boolean {
  return snapshot.statuses.some(
    (status) => status.availability.status === "ready"
  );
}

export async function openFusionNotificationAgent(input: {
  fusionApi: DesktopFusionApi;
  payload: DesktopHostNotificationNavigationPayload;
}): Promise<void> {
  const state = await input.fusionApi.getState();
  const attached = [...state.windows]
    .filter(
      (window) =>
        window.kind === "agent" &&
        window.workspaceId === input.payload.workspaceId &&
        window.resourceId === input.payload.agentSessionId
    )
    .sort(
      (left, right) =>
        right.lastFocusedAtUnixMs - left.lastFocusedAtUnixMs ||
        right.createdAtUnixMs - left.createdAtUnixMs
    )[0];
  if (attached) {
    await input.fusionApi.focusWindow({
      windowInstanceId: attached.windowInstanceId
    });
    return;
  }
  await input.fusionApi.openWindow({
    forceNew: false,
    kind: "agent",
    launchPayload: {
      agentSessionId: input.payload.agentSessionId,
      provider: input.payload.provider
    },
    resourceId: input.payload.agentSessionId,
    workspaceId: input.payload.workspaceId
  });
}
