import type { WorkbenchHostActivation } from "@tutti-os/workbench-surface";
import {
  desktopAgentGUIPrefillPromptActivationType,
  isDesktopAgentGUIProvider,
  type DesktopAgentGUIProvider,
  type DesktopAgentGUIPrefillPromptPayload
} from "../desktopAgentGUINodeState.ts";

export interface DesktopAgentGUIPrefillPromptRequest {
  agentTargetId?: string | null;
  autoSubmit?: boolean;
  draftPrompt: string;
  model?: string;
  modelPlanId?: string;
  provider?: DesktopAgentGUIProvider;
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
    ...(activation.payload.agentTargetId?.trim()
      ? { agentTargetId: activation.payload.agentTargetId.trim() }
      : {}),
    ...(activation.payload.autoSubmit ? { autoSubmit: true } : {}),
    ...(activation.payload.model?.trim()
      ? { model: activation.payload.model.trim() }
      : {}),
    ...(activation.payload.modelPlanId?.trim()
      ? { modelPlanId: activation.payload.modelPlanId.trim() }
      : {}),
    ...(isDesktopAgentGUIProvider(activation.payload.provider)
      ? { provider: activation.payload.provider }
      : {}),
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
