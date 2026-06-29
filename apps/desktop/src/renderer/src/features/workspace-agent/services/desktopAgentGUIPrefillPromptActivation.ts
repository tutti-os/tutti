import type { WorkbenchHostActivation } from "@tutti-os/workbench-surface";
import {
  desktopAgentGUIPrefillPromptActivationType,
  type DesktopAgentGUIPrefillPromptPayload
} from "../desktopAgentGUINodeState.ts";

export interface DesktopAgentGUIPrefillPromptRequest {
  agentSessionId?: string;
  autoSubmit?: boolean;
  draftPrompt: string;
  sequence: number;
  userProjectPath?: string;
}

export interface ConsumeDesktopAgentGUIPrefillPromptActivationInput {
  activation: WorkbenchHostActivation | null;
  clearNodeActivation?: (this: void, nodeId: string, sequence: number) => void;
  handledSequence: number | null;
  markHandled(this: void, sequence: number): void;
  nodeId: string;
}

export function consumeDesktopAgentGUIPrefillPromptActivation({
  activation,
  clearNodeActivation,
  handledSequence,
  markHandled,
  nodeId
}: ConsumeDesktopAgentGUIPrefillPromptActivationInput): DesktopAgentGUIPrefillPromptRequest | null {
  const request = resolveDesktopAgentGUIPrefillPromptActivation(activation);
  if (!request || handledSequence === request.sequence) {
    return null;
  }

  markHandled(request.sequence);
  clearNodeActivation?.(nodeId, request.sequence);
  return request;
}

export function resolveDesktopAgentGUIPrefillPromptActivation(
  activation: WorkbenchHostActivation | null
): DesktopAgentGUIPrefillPromptRequest | null {
  if (
    !activation ||
    activation.type !== desktopAgentGUIPrefillPromptActivationType ||
    !isDesktopAgentGUIPrefillPromptPayload(activation.payload)
  ) {
    return null;
  }

  const draftPrompt = activation.payload.draftPrompt.trim();
  if (!draftPrompt) {
    return null;
  }

  return {
    draftPrompt,
    sequence: activation.sequence,
    ...(activation.payload.agentSessionId?.trim()
      ? { agentSessionId: activation.payload.agentSessionId.trim() }
      : {}),
    ...(activation.payload.autoSubmit ? { autoSubmit: true } : {}),
    ...(activation.payload.userProjectPath?.trim()
      ? { userProjectPath: activation.payload.userProjectPath.trim() }
      : {})
  };
}

function isDesktopAgentGUIPrefillPromptPayload(
  payload: unknown
): payload is DesktopAgentGUIPrefillPromptPayload {
  return (
    Boolean(payload) &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    typeof (payload as Partial<DesktopAgentGUIPrefillPromptPayload>)
      .draftPrompt === "string"
  );
}
