import type { AgentGUIComposerAppendRequest } from "@tutti-os/agent-gui";
import {
  agentGuiWorkbenchSelectConnectorActivationType,
  type AgentGuiWorkbenchSelectConnectorPayload
} from "@tutti-os/agent-gui/workbench/types";
import type { WorkbenchHostActivation } from "@tutti-os/workbench-surface";

export function resolveDesktopAgentGUIConnectorSelectionActivation(
  activation: WorkbenchHostActivation | null
): AgentGUIComposerAppendRequest | null {
  if (
    !activation ||
    activation.type !== agentGuiWorkbenchSelectConnectorActivationType ||
    !activation.payload ||
    typeof activation.payload !== "object" ||
    Array.isArray(activation.payload)
  ) {
    return null;
  }
  const connectorKey = (
    activation.payload as Partial<AgentGuiWorkbenchSelectConnectorPayload>
  ).connectorKey;
  if (typeof connectorKey !== "string" || !connectorKey.trim()) {
    return null;
  }
  return {
    connectorKey: connectorKey.trim(),
    sequence: activation.sequence
  };
}
