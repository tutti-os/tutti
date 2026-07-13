import type { WorkspaceAgentSessionDetailToolCall } from "../../workspaceAgentSessionDetailViewModel";
import { extractAgentMcpToolTarget } from "../../agentMcpToolTarget";
import type { AgentToolCallVM } from "../contracts/agentToolCallVM";
import { projectAgentApprovalItem } from "./agentApprovalProjection";
import {
  projectAgentAskUserQuestionItem,
  projectAgentPlanModeItem
} from "./agentInteractiveProjection";
import { projectAgentTaskItem } from "./agentTaskProjection";
import { resolveAgentToolRendererKind } from "./agentToolRendererKind";

export function projectAgentToolCall(
  call: WorkspaceAgentSessionDetailToolCall
): AgentToolCallVM {
  const toolState = objectValue(call.payload?.tool_state);
  const input = normalizeStandardACPEnvelope(
    objectValue(call.payload?.input) ?? objectValue(toolState?.input)
  );
  const output = normalizeStandardACPEnvelope(
    objectValue(call.payload?.output) ?? objectValue(toolState?.output)
  );
  const error = normalizeStandardACPEnvelope(
    objectValue(call.payload?.error) ?? objectValue(toolState?.error)
  );
  const metadata = objectValue(call.payload?.metadata);
  const content = arrayValue(call.payload?.content);
  const locations = arrayValue(call.payload?.locations);
  const approval = projectAgentApprovalItem(call, input, output);
  const askUserQuestion = projectAgentAskUserQuestionItem(call, input, output);
  const planMode = projectAgentPlanModeItem(call, input);
  const task = projectAgentTaskItem(call, input, output, metadata);
  const mcpTarget = extractAgentMcpToolTarget({
    input,
    metadata,
    payload: call.payload,
    toolName: call.toolName,
    name: call.name
  });
  const rendererKind = resolveAgentToolRendererKind(
    {
      toolName: call.toolName,
      displayName: call.name,
      callType: call.callType,
      input,
      output,
      content,
      metadata
    },
    approval,
    askUserQuestion,
    planMode,
    task
  );
  const projectedCall: AgentToolCallVM = {
    kind: "tool-call",
    ...call,
    turnId: call.turnId ?? "turn:unknown",
    name: mcpTarget?.displayName ?? call.name,
    compactSummary: call.compactSummary ?? call.summary,
    payload: call.payload ?? null,
    toolState,
    input,
    output,
    error,
    metadata,
    content,
    locations,
    rendererKind,
    approval,
    askUserQuestion,
    planMode,
    task,
    occurredAtUnixMs: call.occurredAtUnixMs ?? null
  };
  if (call.sourceTimelineItems) {
    projectedCall.sourceTimelineItems = call.sourceTimelineItems;
  }
  return projectedCall;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function arrayValue(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function normalizeStandardACPEnvelope(
  value: Record<string, unknown> | null
): Record<string, unknown> | null {
  if (!value) return null;
  const raw = objectValue(value.rawInput) ?? objectValue(value.rawOutput);
  if (!raw) return value;
  const metadata = objectValue(raw.metadata);
  return {
    ...value,
    ...raw,
    ...(metadata?.diff !== undefined ? { diff: metadata.diff } : {}),
    ...(metadata?.files !== undefined ? { files: metadata.files } : {}),
    ...(metadata?.structuredPatch !== undefined
      ? { structuredPatch: metadata.structuredPatch }
      : {}),
    ...(metadata?.detailedContent !== undefined
      ? { detailedContent: metadata.detailedContent }
      : {}),
    ...(metadata?.changes !== undefined ? { changes: metadata.changes } : {}),
    ...(metadata?.exit !== undefined ? { exitCode: metadata.exit } : {})
  };
}
