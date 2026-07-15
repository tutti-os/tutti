import type { AgentAskUserQuestionItemVM } from "../contracts/agentAskUserQuestionItemVM";
import type { AgentPlanModeItemVM } from "../contracts/agentPlanModeItemVM";
import type { AgentTaskItemVM } from "../contracts/agentTaskItemVM";
import type {
  AgentToolCallVM,
  AgentToolRendererKind
} from "../contracts/agentToolCallVM";
import { isImageGenerationToolCall } from "../../imageGenerationTool";

interface AgentToolRendererProbe {
  toolName: string | null | undefined;
  displayName?: string | null | undefined;
  callType: string | null | undefined;
  input?: Record<string, unknown> | null;
  output?: Record<string, unknown> | null;
  content?: unknown[] | null;
  metadata?: Record<string, unknown> | null;
}

export function resolveAgentToolRendererKind(
  call: AgentToolRendererProbe,
  approval: AgentToolCallVM["approval"] = null,
  askUserQuestion: AgentAskUserQuestionItemVM | null = null,
  planMode: AgentPlanModeItemVM | null = null,
  task: AgentTaskItemVM | null = null
): AgentToolRendererKind {
  const normalizedToolName = normalizeToolName(call.toolName);
  const normalizedCallType = normalizeCallType(call.callType);
  if (approval) {
    return "approval";
  }
  if (askUserQuestion) {
    return "ask-user";
  }
  if (normalizedToolName === "askuserquestion") {
    return "ask-user";
  }
  if (planMode?.kind === "enter") {
    return "plan-enter";
  }
  if (normalizedToolName === "enterplanmode") {
    return "plan-enter";
  }
  if (planMode?.kind === "exit") {
    return "plan-exit";
  }
  if (normalizedToolName === "exitplanmode") {
    return "plan-exit";
  }
  if (normalizedCallType === "approval" || normalizedToolName === "approval") {
    return "approval";
  }
  if (task) {
    return "task";
  }
  if (
    ["task", "subagent", "delegatetask", "delegateagent", "agent"].includes(
      normalizedToolName
    )
  ) {
    return "task";
  }
  if (
    isImageGenerationToolCall({
      toolName: call.toolName,
      displayName: call.displayName,
      content: call.content,
      outputContent: call.output?.content,
      inputPrompt: call.input?.prompt
    })
  ) {
    return "image-generation";
  }
  switch (normalizedToolName) {
    case "read":
    case "readfile":
      return "read";
    case "write":
    case "writefile":
      return "write";
    case "edit":
    case "editfile":
    case "multiedit":
      return "edit";
    case "bash":
    case "shell":
    case "exec":
    case "execcommand":
      return "bash";
    case "grep":
    case "glob":
    case "search":
    case "searchfiles":
      return "search";
    case "websearch":
      return "web-search";
    case "webfetch":
      return "web-fetch";
    case "todowrite":
      return "todo-write";
    case "toolsearch":
      return "tool-search";
    case "skill":
      return "skill";
    default:
      if (
        normalizedCallType === "mcp" ||
        normalizedToolName.startsWith("mcp") ||
        hasMcpMetadata(call.metadata)
      ) {
        return "mcp";
      }
      return "default";
  }
}

export function inferToolCallType(toolName: string | null | undefined): string {
  const normalizedToolName = normalizeToolName(toolName);
  if (normalizedToolName === "approval") {
    return "approval";
  }
  if (
    ["askuserquestion", "enterplanmode", "exitplanmode"].includes(
      normalizedToolName
    )
  ) {
    return "interactive";
  }
  if (normalizedToolName.startsWith("mcp")) {
    return "mcp";
  }
  return "tool";
}

export function isApprovalToolCall(call: {
  toolName: string | null | undefined;
  callType: string | null | undefined;
}): boolean {
  return (
    normalizeCallType(call.callType) === "approval" ||
    normalizeToolName(call.toolName) === "approval"
  );
}

export function normalizeToolName(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/[_\s-]+/g, "")
    .trim()
    .toLowerCase();
}

function hasMcpMetadata(
  metadata: Record<string, unknown> | null | undefined
): boolean {
  return Boolean(
    stringValue(metadata?.server) ??
    stringValue(metadata?.serverName) ??
    stringValue(metadata?.mcpServer)
  );
}

function normalizeCallType(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
