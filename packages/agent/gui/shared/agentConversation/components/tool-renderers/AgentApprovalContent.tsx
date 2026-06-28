import type { JSX } from "react";
import type { AgentToolCallVM } from "../../contracts/agentToolCallVM";
import { AgentEditContent } from "./AgentEditContent";
import {
  arrayValue,
  objectValue,
  stringValue,
  ToolMarkdownBlock,
  ToolSection,
  type AgentToolRendererProps
} from "./agentToolContentShared";
import { getPromptToolDetails } from "../../promptToolDetails";
import { translate } from "../../../../i18n/index";

export function AgentApprovalContent({
  call,
  onLinkClick
}: AgentToolRendererProps): JSX.Element | null {
  "use memo";
  const previewCall = approvalPreviewCall(call);
  if (previewCall) {
    return <AgentEditContent call={previewCall} onLinkClick={onLinkClick} />;
  }
  const toolDetails = getPromptToolDetails(call.input ?? null);
  const summary = call.summary.trim();
  if (toolDetails.length === 0 && !summary) {
    return null;
  }
  return (
    <div className="workspace-agents-status-panel__detail-tool-body">
      {toolDetails.length > 0 ? (
        <ToolSection title="Details">
          {toolDetails.map((detail) => (
            <div
              key={`${detail.kind}:${detail.value}`}
              className="workspace-agents-status-panel__detail-approval-detail-row"
            >
              <span className="workspace-agents-status-panel__detail-approval-detail-label">
                {promptToolDetailLabel(detail.kind)}
              </span>
              <span className="workspace-agents-status-panel__detail-approval-detail-value">
                {detail.value}
              </span>
              {detail.meta ? (
                <span className="workspace-agents-status-panel__detail-approval-detail-meta">
                  {detail.meta}
                </span>
              ) : null}
            </div>
          ))}
        </ToolSection>
      ) : null}
      {summary ? <ToolMarkdownBlock content={summary} onLinkClick={onLinkClick} /> : null}
    </div>
  );
}

function approvalPreviewCall(call: AgentToolCallVM): AgentToolCallVM | null {
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

function normalizeToolKind(value: string | null): string {
  return (value ?? "").trim().toLowerCase();
}

function promptToolDetailLabel(kind: "command" | "mcp" | "path" | "query"): string {
  switch (kind) {
    case "command":
      return translate("agentHost.agentTool.details.command");
    case "mcp":
      return translate("agentHost.agentTool.details.mcp");
    case "path":
      return translate("agentHost.agentTool.details.path");
    case "query":
      return translate("agentHost.agentTool.details.query");
  }
}
