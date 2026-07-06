import type { AgentActivityRuntime } from "@tutti-os/agent-gui";
import type { WorkbenchHostActivation } from "@tutti-os/workbench-surface";
import {
  areDesktopAgentGUINodeStatesEqual,
  areDesktopAgentGUIWorkbenchStatesEqual,
  desktopAgentGUIOpenSessionActivationType,
  normalizeDesktopAgentGUINodeState,
  projectDesktopAgentGUIWorkbenchState,
  type DesktopAgentGUINodeState,
  type DesktopAgentGUIProvider,
  type DesktopAgentGUIWorkbenchState
} from "../desktopAgentGUINodeState.ts";

export interface ConsumeDesktopAgentGUIOpenSessionActivationInput {
  activation: WorkbenchHostActivation | null;
  agentActivityRuntime: Pick<AgentActivityRuntime, "activateSession">;
  clearNodeActivation?: (this: void, nodeId: string, sequence: number) => void;
  handledSequence: number | null;
  markHandled(this: void, sequence: number): void;
  nodeId: string;
  onActivationError?(
    this: void,
    input: { agentSessionId: string; error: unknown }
  ): void;
  onOpenSessionRequest?(
    this: void,
    request: { agentSessionId: string; sequence: number }
  ): void;
  onStateChange(this: void, state: DesktopAgentGUIWorkbenchState): void;
  provider: DesktopAgentGUIProvider;
  resolveAgentTargetProvider?(
    this: void,
    agentTargetId: string | null
  ): DesktopAgentGUIProvider | null;
  workspaceId: string;
  updateNodeState(
    this: void,
    updater: (current: DesktopAgentGUINodeState) => DesktopAgentGUINodeState
  ): void;
}

export function consumeDesktopAgentGUIOpenSessionActivation({
  activation,
  agentActivityRuntime,
  clearNodeActivation,
  handledSequence,
  markHandled,
  nodeId,
  onActivationError,
  onOpenSessionRequest,
  onStateChange,
  provider,
  resolveAgentTargetProvider,
  workspaceId,
  updateNodeState
}: ConsumeDesktopAgentGUIOpenSessionActivationInput): boolean {
  const request = resolveDesktopAgentGUIOpenSessionActivation(activation);
  if (!request || handledSequence === request.sequence) {
    return false;
  }

  markHandled(request.sequence);
  clearNodeActivation?.(nodeId, request.sequence);
  onOpenSessionRequest?.(request);
  void agentActivityRuntime
    .activateSession({
      workspaceId,
      agentSessionId: request.agentSessionId,
      mode: "existing"
    })
    .catch((error: unknown) => {
      onActivationError?.({ agentSessionId: request.agentSessionId, error });
    });
  updateNodeState((current) => {
    const currentAgentTargetId =
      current.agentTargetId?.trim() || current.providerTargetId?.trim() || null;
    const currentAgentTargetProvider = currentAgentTargetId
      ? (resolveAgentTargetProvider?.(currentAgentTargetId) ?? null)
      : null;
    const shouldClearAgentTarget =
      currentAgentTargetProvider !== null &&
      currentAgentTargetProvider !== provider;
    const next = normalizeDesktopAgentGUINodeState(
      {
        ...current,
        ...(shouldClearAgentTarget
          ? {
              agentTargetId: null,
              providerTargetId: null,
              providerTargetRef: null
            }
          : {}),
        lastActiveAgentSessionId: request.agentSessionId,
        provider
      },
      provider
    );
    if (areDesktopAgentGUINodeStatesEqual(current, next)) {
      return current;
    }

    const currentWorkbenchState = projectDesktopAgentGUIWorkbenchState(current);
    const nextWorkbenchState = projectDesktopAgentGUIWorkbenchState(next);
    if (
      !areDesktopAgentGUIWorkbenchStatesEqual(
        currentWorkbenchState,
        nextWorkbenchState
      )
    ) {
      onStateChange(nextWorkbenchState);
    }
    return next;
  });
  return true;
}

export function resolveDesktopAgentGUIOpenSessionActivation(
  activation: WorkbenchHostActivation | null
): { agentSessionId: string; sequence: number } | null {
  if (
    !activation ||
    activation.type !== desktopAgentGUIOpenSessionActivationType
  ) {
    return null;
  }

  const agentSessionId = agentSessionIdFromOpenSessionActivationPayload(
    activation.payload
  );
  return agentSessionId
    ? {
        agentSessionId,
        sequence: activation.sequence
      }
    : null;
}

function agentSessionIdFromOpenSessionActivationPayload(
  payload: unknown
): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const agentSessionId = (payload as { agentSessionId?: unknown })
    .agentSessionId;
  return typeof agentSessionId === "string" && agentSessionId.trim()
    ? agentSessionId.trim()
    : null;
}
