import type { JSX } from "react";
import type { AgentToolCallVM } from "../../contracts/agentToolCallVM";
import { AgentEditContent } from "./AgentEditContent";
import {
  AgentDefaultToolContent,
  arrayValue,
  objectValue,
  stringValue,
  ToolMarkdownBlock,
  type AgentToolRendererProps
} from "./agentToolContentShared";

export function AgentApprovalContent({
  call,
  onLinkClick
}: AgentToolRendererProps): JSX.Element | null {
  "use memo";
  const editPreviewCall = approvalEditPreviewCall(call);
  const genericPreviewCall = editPreviewCall
    ? null
    : approvalGenericPreviewCall(call);
  if (!editPreviewCall && !genericPreviewCall && !call.summary.trim()) {
    return null;
  }
  if (editPreviewCall) {
    return (
      <AgentEditContent call={editPreviewCall} onLinkClick={onLinkClick} />
    );
  }
  if (genericPreviewCall) {
    return (
      <AgentDefaultToolContent
        call={genericPreviewCall}
        onLinkClick={onLinkClick}
      />
    );
  }
  return (
    <div className="workspace-agents-status-panel__detail-tool-body">
      <ToolMarkdownBlock content={call.summary} />
    </div>
  );
}

function approvalEditPreviewCall(
  call: AgentToolCallVM
): AgentToolCallVM | null {
  const toolCall = objectValue(call.input?.toolCall);
  if (!toolCall) {
    return null;
  }
  const normalizedKind = normalizeToolKind(
    stringValue(toolCall.kind) ??
      stringValue(toolCall.title) ??
      stringValue(toolCall.toolName)
  );
  if (normalizedKind !== "edit" && normalizedKind !== "move") {
    return null;
  }
  const input = objectValue(toolCall.rawInput);
  const content = arrayValue(toolCall.content);
  const locations = arrayValue(toolCall.locations);
  return {
    kind: "tool-call",
    id: `${call.id}:approval-preview`,
    turnId: call.turnId,
    name: stringValue(toolCall.title) ?? call.name,
    toolName: "Edit",
    callType: "tool",
    status: stringValue(toolCall.status) ?? call.status,
    statusKind: call.statusKind,
    summary: "",
    compactSummary: null,
    payload: {
      input,
      content,
      locations
    },
    toolState: null,
    input,
    output: null,
    error: null,
    metadata: null,
    content,
    locations,
    rendererKind: "edit",
    approval: null,
    planMode: null,
    askUserQuestion: null,
    task: null,
    occurredAtUnixMs: call.occurredAtUnixMs
  };
}

function approvalGenericPreviewCall(
  call: AgentToolCallVM
): AgentToolCallVM | null {
  const toolCall = objectValue(call.input?.toolCall);
  if (!toolCall) {
    return null;
  }
  const input = objectValue(toolCall.rawInput);
  const content = arrayValue(toolCall.content);
  const toolTitle =
    stringValue(toolCall.title) ?? stringValue(toolCall.toolName) ?? call.name;
  return {
    kind: "tool-call",
    id: `${call.id}:approval-preview`,
    turnId: call.turnId,
    name: toolTitle,
    toolName: toolTitle,
    callType: "tool",
    status: stringValue(toolCall.status) ?? call.status,
    statusKind: call.statusKind,
    summary: "",
    compactSummary: null,
    payload: { input, content },
    toolState: null,
    input,
    output: null,
    error: null,
    metadata: null,
    content,
    locations: null,
    rendererKind: "default",
    approval: null,
    planMode: null,
    askUserQuestion: null,
    task: null,
    occurredAtUnixMs: call.occurredAtUnixMs
  };
}

function normalizeToolKind(value: string | null): string {
  return (value ?? "").trim().toLowerCase();
}
