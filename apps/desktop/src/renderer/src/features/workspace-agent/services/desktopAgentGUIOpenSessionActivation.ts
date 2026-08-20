import type {
  AgentGUIAgentDirectoryStatus,
  AgentGUIRuntime
} from "@tutti-os/agent-gui";
import { selectEngineSession } from "@tutti-os/agent-activity-core";
import type { WorkbenchHostActivation } from "@tutti-os/workbench-surface";
import {
  areDesktopAgentGUINodeStatesEqual,
  areDesktopAgentGUIWorkbenchStatesEqual,
  desktopAgentGUIOpenSessionActivationType,
  isDesktopAgentGUIProvider,
  normalizeDesktopAgentGUIProvider,
  normalizeDesktopAgentGUINodeState,
  projectDesktopAgentGUIWorkbenchState,
  type DesktopAgentGUINodeState,
  type DesktopAgentGUIProvider,
  type DesktopAgentGUIWorkbenchState
} from "../desktopAgentGUINodeState.ts";
import {
  resolveDesktopAgentGUIOpenSessionComposerActivation,
  type DesktopAgentGUIOpenSessionComposerRequest
} from "./desktopAgentGUIOpenSessionComposerActivation.ts";

export interface ConsumeDesktopAgentGUIOpenSessionActivationInput {
  activation: WorkbenchHostActivation | null;
  agentActivityRuntime: Pick<AgentGUIRuntime, "getSessionEngine">;
  agentDirectoryStatus: AgentGUIAgentDirectoryStatus;
  clearNodeActivation?: (this: void, nodeId: string, sequence: number) => void;
  handledSequence: number | null;
  markHandled(this: void, sequence: number): void;
  nodeId: string;
  onOpenSessionRequest?(
    this: void,
    request: DesktopAgentGUIOpenSessionRequest
  ): void;
  onOpenSessionRejected?(
    this: void,
    request: DesktopAgentGUIOpenSessionRequest | null,
    reason: DesktopAgentGUIOpenSessionRejectionReason
  ): void;
  onOpenSessionComposerRequest?(
    this: void,
    request: DesktopAgentGUIOpenSessionComposerRequest | null
  ): void;
  onStateChange(this: void, state: DesktopAgentGUIWorkbenchState): void;
  provider: DesktopAgentGUIProvider | null;
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

export interface DesktopAgentGUIOpenSessionRequest {
  agentSessionId: string;
  agentTargetId?: string | null;
  provider?: DesktopAgentGUIProvider;
  sequence: number;
}

export type DesktopAgentGUIOpenSessionRejectionReason =
  | "agent-target-unavailable"
  | "invalid-request"
  | "provider-mismatch"
  | "session-activation-rejected"
  | "session-identity-mismatch";

export function consumeDesktopAgentGUIOpenSessionActivation({
  activation,
  agentActivityRuntime,
  agentDirectoryStatus,
  clearNodeActivation,
  handledSequence,
  markHandled,
  nodeId,
  onOpenSessionRequest,
  onOpenSessionRejected,
  onOpenSessionComposerRequest,
  onStateChange,
  provider,
  resolveAgentTargetProvider,
  workspaceId,
  updateNodeState
}: ConsumeDesktopAgentGUIOpenSessionActivationInput): boolean {
  const request = resolveDesktopAgentGUIOpenSessionActivation(activation);
  if (!request) {
    if (
      activation?.type === desktopAgentGUIOpenSessionActivationType &&
      handledSequence !== activation.sequence
    ) {
      markHandled(activation.sequence);
      clearNodeActivation?.(nodeId, activation.sequence);
      onOpenSessionRejected?.(null, "invalid-request");
    }
    return false;
  }
  if (handledSequence === request.sequence) {
    return false;
  }

  const hasRequestedAgentTarget = Object.prototype.hasOwnProperty.call(
    request,
    "agentTargetId"
  );
  const requestedAgentTargetId = request.agentTargetId?.trim() || null;
  const resolvedTargetProvider = requestedAgentTargetId
    ? (resolveAgentTargetProvider?.(requestedAgentTargetId) ?? null)
    : null;
  if (
    requestedAgentTargetId &&
    !resolvedTargetProvider &&
    (agentDirectoryStatus === "idle" || agentDirectoryStatus === "loading")
  ) {
    return false;
  }
  if (requestedAgentTargetId && !resolvedTargetProvider) {
    markHandled(request.sequence);
    clearNodeActivation?.(nodeId, request.sequence);
    onOpenSessionRejected?.(request, "agent-target-unavailable");
    return false;
  }
  if (
    requestedAgentTargetId &&
    request.provider &&
    resolvedTargetProvider !== request.provider
  ) {
    markHandled(request.sequence);
    clearNodeActivation?.(nodeId, request.sequence);
    onOpenSessionRejected?.(request, "provider-mismatch");
    return false;
  }
  const sessionEngine = agentActivityRuntime.getSessionEngine(workspaceId);
  const knownSession = selectEngineSession(
    sessionEngine.getSnapshot(),
    request.agentSessionId
  );
  const knownSessionTargetId = knownSession?.agentTargetId?.trim() || null;
  const knownSessionProvider = knownSession?.provider.trim() || null;
  if (
    knownSession &&
    ((hasRequestedAgentTarget &&
      knownSessionTargetId !== requestedAgentTargetId) ||
      (request.provider && knownSessionProvider !== request.provider))
  ) {
    markHandled(request.sequence);
    clearNodeActivation?.(nodeId, request.sequence);
    onOpenSessionRejected?.(request, "session-identity-mismatch");
    return false;
  }
  const requestedProviderInput =
    resolvedTargetProvider ?? request.provider ?? provider;
  if (!requestedProviderInput) {
    if (agentDirectoryStatus === "idle" || agentDirectoryStatus === "loading") {
      return false;
    }
    markHandled(request.sequence);
    clearNodeActivation?.(nodeId, request.sequence);
    onOpenSessionRejected?.(request, "invalid-request");
    return false;
  }
  const requestedProvider = normalizeDesktopAgentGUIProvider(
    requestedProviderInput
  );
  const activationAccepted = sessionEngine.activateSession({
    agentSessionId: request.agentSessionId,
    mode: "existing",
    requestId: [
      "workbench-open-session",
      workspaceId,
      nodeId,
      request.agentSessionId,
      request.sequence
    ].join(":")
  });
  if (!activationAccepted) {
    markHandled(request.sequence);
    clearNodeActivation?.(nodeId, request.sequence);
    onOpenSessionRejected?.(request, "session-activation-rejected");
    return false;
  }

  markHandled(request.sequence);
  clearNodeActivation?.(nodeId, request.sequence);
  if (!hasRequestedAgentTarget) {
    updateNodeState((current) => {
      const currentAgentTargetId = current.agentTargetId?.trim() || null;
      const currentAgentTargetProvider = currentAgentTargetId
        ? (resolveAgentTargetProvider?.(currentAgentTargetId) ?? null)
        : null;
      const shouldClearAgentTarget =
        currentAgentTargetProvider !== null &&
        currentAgentTargetProvider !== requestedProvider;
      const next = normalizeDesktopAgentGUINodeState(
        {
          ...current,
          ...(shouldClearAgentTarget ? { agentTargetId: null } : {}),
          lastActiveAgentSessionId: request.agentSessionId,
          provider: requestedProvider
        },
        requestedProvider
      );
      if (areDesktopAgentGUINodeStatesEqual(current, next)) {
        return current;
      }

      const currentWorkbenchState =
        projectDesktopAgentGUIWorkbenchState(current);
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
  }
  onOpenSessionRequest?.(request);
  const composerRequest =
    resolveDesktopAgentGUIOpenSessionComposerActivation(activation);
  onOpenSessionComposerRequest?.(
    composerRequest?.agentSessionId === request.agentSessionId
      ? composerRequest
      : null
  );
  return true;
}

export function resolveDesktopAgentGUIOpenSessionActivation(
  activation: WorkbenchHostActivation | null
): DesktopAgentGUIOpenSessionRequest | null {
  if (
    !activation ||
    activation.type !== desktopAgentGUIOpenSessionActivationType
  ) {
    return null;
  }

  const payload = openSessionActivationPayload(activation.payload);
  return payload ? { ...payload, sequence: activation.sequence } : null;
}

function openSessionActivationPayload(
  payload: unknown
): Omit<DesktopAgentGUIOpenSessionRequest, "sequence"> | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const agentSessionId = record.agentSessionId;
  if (typeof agentSessionId !== "string" || !agentSessionId.trim()) {
    return null;
  }
  const rawAgentTargetId = record.agentTargetId;
  const hasAgentTargetId =
    rawAgentTargetId !== undefined &&
    Object.prototype.hasOwnProperty.call(record, "agentTargetId");
  if (
    hasAgentTargetId &&
    rawAgentTargetId !== null &&
    (typeof rawAgentTargetId !== "string" || !rawAgentTargetId.trim())
  ) {
    return null;
  }
  const rawProvider = record.provider;
  if (
    rawProvider !== undefined &&
    (!isDesktopAgentGUIProvider(rawProvider) || !rawProvider.trim())
  ) {
    return null;
  }
  return {
    agentSessionId: agentSessionId.trim(),
    ...(hasAgentTargetId
      ? {
          agentTargetId:
            typeof rawAgentTargetId === "string"
              ? rawAgentTargetId.trim()
              : null
        }
      : {}),
    ...(typeof rawProvider === "string"
      ? { provider: normalizeDesktopAgentGUIProvider(rawProvider) }
      : {})
  };
}
