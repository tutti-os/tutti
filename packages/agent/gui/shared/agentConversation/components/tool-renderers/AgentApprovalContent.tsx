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
  const previewCall = approvalPreviewCall(call);
  if (!previewCall && !call.summary.trim()) {
    return null;
  }
  if (previewCall) {
    if (previewCall.rendererKind === "edit") {
      return <AgentEditContent call={previewCall} onLinkClick={onLinkClick} />;
    }
    return (
      <AgentDefaultToolContent call={previewCall} onLinkClick={onLinkClick} />
    );
  }
  return (
    <div className="workspace-agents-status-panel__detail-tool-body">
      <ToolMarkdownBlock content={call.summary} />
    </div>
  );
}

function approvalPreviewCall(call: AgentToolCallVM): AgentToolCallVM | null {
  const toolCall = objectValue(call.input?.toolCall);
  if (!toolCall) {
    return null;
  }
  const input = objectValue(toolCall.rawInput);
  const content = arrayValue(toolCall.content);
  const locations = arrayValue(toolCall.locations);
  const normalizedKind = normalizeToolKind(
    stringValue(toolCall.kind) ??
      stringValue(toolCall.title) ??
      stringValue(toolCall.toolName)
  );
  const isEditLike = normalizedKind === "edit" || normalizedKind === "move";
  return {
    kind: "tool-call",
    id: `${call.id}:approval-preview`,
    turnId: call.turnId,
    name: stringValue(toolCall.title) ?? call.name,
    toolName: isEditLike
      ? "Edit"
      : (stringValue(toolCall.toolName) ?? call.name),
    callType: "tool",
    status: stringValue(toolCall.status) ?? call.status,
    statusKind: call.statusKind,
    summary: call.summary,
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
    rendererKind: isEditLike ? "edit" : "default",
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
