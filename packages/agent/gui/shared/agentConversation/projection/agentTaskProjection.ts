import type { WorkspaceAgentSessionDetailToolCall } from "../../workspaceAgentSessionDetailViewModel";
import type {
  AgentTaskItemVM,
  AgentTaskStepVM
} from "../contracts/agentTaskItemVM";
import type { AgentToolCallVM } from "../contracts/agentToolCallVM";
import { projectAgentApprovalItem } from "./agentApprovalProjection";
import {
  projectAgentAskUserQuestionItem,
  projectAgentPlanModeItem
} from "./agentInteractiveProjection";
import {
  inferToolCallType,
  normalizeToolName,
  resolveAgentToolRendererKind
} from "./agentToolRendererKind";

export function projectAgentTaskItem(
  call: WorkspaceAgentSessionDetailToolCall,
  input: Record<string, unknown> | null,
  output: Record<string, unknown> | null,
  metadata: Record<string, unknown> | null
): AgentTaskItemVM | null {
  const toolName = normalizeToolName(call.toolName);
  if (
    !["task", "subagent", "delegatetask", "delegateagent", "agent"].includes(
      toolName
    )
  ) {
    return null;
  }
  const claudeToolResponse =
    claudeCodeToolResponse(input) ??
    claudeCodeToolResponse(output) ??
    claudeCodeToolResponse(metadata);
  const steps = normalizeTaskSteps(
    arrayValue(metadata?.steps) ??
      arrayValue(output?.steps) ??
      arrayValue(call.payload?.steps) ??
      [],
    call.turnId ?? "turn:unknown"
  );
  return {
    kind: "task",
    id: call.id,
    turnId: call.turnId ?? "turn:unknown",
    title: call.summary.trim() || call.name,
    status:
      stringValue(metadata?.taskStatus) ??
      stringValue(metadata?.subagentStatus) ??
      call.status,
    prompt:
      stringValue(input?.prompt) ??
      stringValue(input?.description) ??
      stringValue(call.payload?.description) ??
      stringValue(claudeToolResponse?.prompt),
    delegateSessionId:
      stringValue(metadata?.childSessionID) ??
      stringValue(metadata?.child_session_id) ??
      stringValue(metadata?.subagentSessionID) ??
      stringValue(metadata?.subagent_session_id) ??
      stringValue(metadata?.subagentAgentId) ??
      stringValue(metadata?.agentId) ??
      stringValue(claudeToolResponse?.agentId),
    steps,
    result: firstNonEmptyText(output),
    resultMarkdown: firstNonEmptyText(output),
    durationMs:
      numberValue(metadata?.durationMs) ??
      numberValue(output?.durationMs) ??
      numberValue(claudeToolResponse?.totalDurationMs),
    occurredAtUnixMs: call.occurredAtUnixMs ?? null
  };
}

function normalizeTaskSteps(
  values: readonly unknown[],
  turnId: string
): AgentTaskStepVM[] {
  return values.flatMap((value, index) => {
    const step = objectValue(value);
    if (!step) {
      return [];
    }
    const toolName =
      stringValue(step.toolName) ??
      stringValue(step.tool_name) ??
      stringValue(step.name);
    const callType = stringValue(step.callType) ?? stringValue(step.call_type);
    const inputPayload =
      objectValue(step.toolInput) ?? objectValue(step.tool_input);
    const outputPayload =
      objectValue(step.toolResult) ?? objectValue(step.tool_result);
    const errorPayload =
      objectValue(step.toolError) ?? objectValue(step.tool_error);
    const payload = objectValue(step.payload);
    const metadata = objectValue(step.metadata);
    const content = arrayValue(step.content);
    const locations = arrayValue(step.locations);
    return [
      {
        id:
          stringValue(step.toolUseId) ??
          stringValue(step.id) ??
          `step-${index + 1}`,
        turnId,
        name: toolName ? humanizeToolLabel(toolName) : `Step ${index + 1}`,
        toolName: toolName ?? null,
        status:
          stringValue(step.status) ??
          stringValue(objectValue(step.toolResult)?.status) ??
          stringValue(objectValue(step.tool_result)?.status),
        summary: firstNonEmptyText(outputPayload, inputPayload) ?? "",
        payload: {
          input: inputPayload,
          output: outputPayload,
          error: errorPayload
        },
        tool: projectAgentTaskStepTool({
          id:
            stringValue(step.toolUseId) ??
            stringValue(step.id) ??
            `step-${index + 1}`,
          turnId,
          toolName,
          name: stringValue(step.name),
          callType,
          status:
            stringValue(step.status) ?? stringValue(outputPayload?.status),
          summary: firstNonEmptyText(outputPayload, inputPayload) ?? "",
          payload,
          metadata,
          input: inputPayload,
          output: outputPayload,
          error: errorPayload,
          content,
          locations,
          occurredAtUnixMs: numberValue(step.occurredAtUnixMs)
        }),
        occurredAtUnixMs: numberValue(step.occurredAtUnixMs) ?? null
      }
    ];
  });
}

export function projectAgentTaskStepTool(step: {
  id: string;
  turnId: string;
  toolName: string | null;
  name: string | null;
  callType: string | null;
  status: string | null;
  summary: string;
  payload: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
  content: unknown[] | null;
  locations: unknown[] | null;
  occurredAtUnixMs: number | null;
}): AgentToolCallVM {
  const call: WorkspaceAgentSessionDetailToolCall = {
    id: `call:${step.id}`,
    turnId: step.turnId,
    name:
      step.name ?? (step.toolName ? humanizeToolLabel(step.toolName) : "Tool"),
    toolName: step.toolName,
    callType: step.callType ?? inferToolCallType(step.toolName),
    status: step.status,
    statusKind: normalizeTaskStepStatus(step.status),
    summary: step.summary,
    compactSummary: step.summary || null,
    payload: step.payload,
    occurredAtUnixMs: step.occurredAtUnixMs
  };
  const approval = projectAgentApprovalItem(call, step.input, step.output);
  const askUserQuestion = projectAgentAskUserQuestionItem(
    call,
    step.input,
    step.output
  );
  const planMode = projectAgentPlanModeItem(call, step.input);
  const task = projectAgentTaskItem(
    call,
    step.input,
    step.output,
    step.metadata
  );
  const rendererKind = resolveAgentToolRendererKind(
    {
      toolName: call.toolName,
      displayName: call.name,
      callType: call.callType,
      input: step.input,
      output: step.output,
      content: step.content,
      metadata: step.metadata
    },
    approval,
    askUserQuestion,
    planMode,
    task
  );
  return {
    kind: "tool-call",
    ...call,
    turnId: step.turnId,
    compactSummary: call.compactSummary ?? null,
    payload: step.payload,
    toolState: null,
    input: step.input,
    output: step.output,
    error: step.error,
    metadata: step.metadata,
    content: step.content,
    locations: step.locations,
    occurredAtUnixMs: call.occurredAtUnixMs ?? null,
    rendererKind,
    approval,
    planMode,
    askUserQuestion,
    task
  };
}

function humanizeToolLabel(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\w/, (match) => match.toUpperCase());
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeTaskStepStatus(
  value: string | null
): AgentToolCallVM["statusKind"] {
  switch ((value ?? "").trim().toLowerCase()) {
    case "completed":
    case "done":
    case "success":
    case "succeeded":
      return "completed";
    case "failed":
    case "error":
    case "errored":
      return "failed";
    case "waiting":
    case "waiting_input":
    case "waiting_approval":
      return "waiting";
    case "running":
    case "working":
    case "active":
      return "working";
    default:
      return null;
  }
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function arrayValue(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function claudeCodeToolResponse(
  value: Record<string, unknown> | null
): Record<string, unknown> | null {
  const meta = objectValue(value?._meta);
  const claudeCode = objectValue(meta?.claudeCode);
  return objectValue(claudeCode?.toolResponse);
}

function firstNonEmptyText(
  ...values: Array<Record<string, unknown> | string | null | undefined>
): string | null {
  for (const value of values) {
    const text = extractText(value);
    if (text) {
      return text;
    }
  }
  return null;
}

function extractText(value: unknown, depth = 0): string | null {
  if (depth > 4) {
    return null;
  }
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = extractText(item, depth + 1);
      if (text) {
        return text;
      }
    }
    return null;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of [
      "text",
      "output",
      "summary",
      "message",
      "patch",
      "result"
    ]) {
      const text = extractText(record[key], depth + 1);
      if (text) {
        return text;
      }
    }
    return extractText(record.content, depth + 1);
  }
  return null;
}
