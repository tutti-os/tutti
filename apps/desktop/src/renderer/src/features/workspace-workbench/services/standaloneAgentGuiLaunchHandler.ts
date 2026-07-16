import type { DesktopHostOpenAgentWindowInput } from "@shared/contracts/ipc";
import type { DesktopAgentGUIProvider } from "@renderer/features/workspace-agent/desktopAgentGUINodeState.ts";
import type { WorkspaceAgentGuiLaunchRequest } from "@renderer/features/workspace-agent/services/workspaceAgentGuiLaunchCoordinator.ts";

export interface StandaloneAgentGuiLaunchHandlerContext {
  activateAgentSession(input: {
    agentSessionId: string;
    agentTargetId: string | null;
    provider: DesktopAgentGUIProvider;
  }): void;
  agentDirectorySnapshot?: DesktopHostOpenAgentWindowInput["agentDirectorySnapshot"];
  headerProvider: DesktopAgentGUIProvider;
  openAgentWindow(input: DesktopHostOpenAgentWindowInput): Promise<void>;
  providerStatusSnapshot?: DesktopHostOpenAgentWindowInput["providerStatusSnapshot"];
  workspaceId: string;
}

export async function handleStandaloneAgentGuiLaunch(
  request: WorkspaceAgentGuiLaunchRequest,
  context: StandaloneAgentGuiLaunchHandlerContext
): Promise<void> {
  const draftPrompt = normalizeOptionalString(request.draftPrompt);
  const agentSessionId = normalizeOptionalString(request.agentSessionId);
  const agentTargetId = normalizeOptionalNullableString(request.agentTargetId);
  const provider = request.provider ?? context.headerProvider;
  const model = normalizeOptionalString(request.model);
  const modelPlanId = normalizeOptionalString(request.modelPlanId);

  if (agentSessionId && !draftPrompt && request.openInNewWindow !== true) {
    context.activateAgentSession({
      agentSessionId,
      agentTargetId: agentTargetId ?? null,
      provider
    });
    return;
  }

  const userProjectPath = normalizeOptionalString(request.userProjectPath);
  await context.openAgentWindow({
    agentSessionId: draftPrompt ? null : (agentSessionId ?? null),
    ...(agentTargetId !== undefined ? { agentTargetId } : {}),
    ...(draftPrompt
      ? {
          ...(request.autoSubmit === true ? { autoSubmit: true } : {}),
          draftPrompt,
          ...(model ? { model } : {}),
          ...(modelPlanId ? { modelPlanId } : {}),
          ...(userProjectPath ? { userProjectPath } : {})
        }
      : {}),
    providerStatusSnapshot: context.providerStatusSnapshot,
    agentDirectorySnapshot: context.agentDirectorySnapshot,
    minimizeSourceWindow: false,
    provider,
    workspaceId: context.workspaceId
  });
}

function normalizeOptionalString(
  value: string | null | undefined
): string | undefined {
  const normalized = value?.trim() || "";
  return normalized || undefined;
}

function normalizeOptionalNullableString(
  value: string | null | undefined
): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  return normalizeOptionalString(value) ?? null;
}
