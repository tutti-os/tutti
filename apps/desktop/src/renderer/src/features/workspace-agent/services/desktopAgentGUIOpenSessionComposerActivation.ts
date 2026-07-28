import type { WorkbenchHostActivation } from "@tutti-os/workbench-surface";
import { desktopAgentGUIOpenSessionActivationType } from "../desktopAgentGUINodeState.ts";

export interface DesktopAgentGUIOpenSessionComposerRequest {
  agentSessionId: string;
  draftPrompt: string;
  focusComposer: true;
  mode: "append";
  sequence: number;
}

export function resolveDesktopAgentGUIOpenSessionComposerActivation(
  activation: WorkbenchHostActivation | null
): DesktopAgentGUIOpenSessionComposerRequest | null {
  if (
    !activation ||
    activation.type !== desktopAgentGUIOpenSessionActivationType ||
    !activation.payload ||
    typeof activation.payload !== "object" ||
    Array.isArray(activation.payload)
  ) {
    return null;
  }

  const payload = activation.payload as {
    agentSessionId?: unknown;
    composerAppend?: unknown;
  };
  if (
    typeof payload.agentSessionId !== "string" ||
    !payload.agentSessionId.trim() ||
    !payload.composerAppend ||
    typeof payload.composerAppend !== "object" ||
    Array.isArray(payload.composerAppend)
  ) {
    return null;
  }
  const draftPrompt = (payload.composerAppend as { draftPrompt?: unknown })
    .draftPrompt;
  if (typeof draftPrompt !== "string" || !draftPrompt.trim()) {
    return null;
  }

  return {
    agentSessionId: payload.agentSessionId.trim(),
    draftPrompt: draftPrompt.trim(),
    focusComposer: true,
    mode: "append",
    sequence: activation.sequence
  };
}
