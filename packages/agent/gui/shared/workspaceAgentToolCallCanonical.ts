import type { WorkspaceAgentActivityTimelineItem } from "./workspaceAgentTimelineTypes";
import { looksLikeOpaqueToolCallIdentifier } from "./workspaceAgentToolCallIdentifiers";
import {
  legacyKindToToolName,
  TOOL_ACTIVITY_KIND_TRANSLATION_KEYS,
  type ToolActivityKind
} from "./workspaceAgentToolCallLabels";

export function resolveCanonicalToolName(
  toolName: string | null | undefined
): string | null {
  const normalized = normalizeToolNameToken(toolName);
  switch (normalized) {
    case "imagegeneration":
    case "imagegen":
    case "generateimage":
    case "generatingimage":
    case "imagegenerate":
    case "imagegenerator":
      return "ImageGeneration";
    case "approval":
      return "Approval";
    case "askuserquestion":
      return "AskUserQuestion";
    case "enterplanmode":
      return "EnterPlanMode";
    case "exitplanmode":
      return "ExitPlanMode";
    case "toolsearch":
      return "ToolSearch";
    case "skill":
      return "Skill";
    case "think":
      return "Think";
    case "bash":
      return "Bash";
    case "read":
      return "Read";
    case "write":
      return "Write";
    case "edit":
      return "Edit";
    case "glob":
      return "Glob";
    case "grep":
      return "Grep";
    case "websearch":
      return "WebSearch";
    case "webfetch":
      return "WebFetch";
    case "todowrite":
      return "TodoWrite";
    case "task":
    case "subagent":
    case "runsubagent":
    case "delegatetask":
    case "delegateagent":
      return "Agent";
    case "agent":
      return "Agent";
    default:
      // Codex/legacy tool calls (including ones reconstructed by the
      // Codex/Claude Code history import pipeline, which does not run the
      // live daemon's canonicalization step) report the raw snake_case
      // provider tool name verbatim, e.g. "apply_patch" for a file edit.
      // Recognize those exactly as the equivalent live-session ToolActivityKind
      // so imported and live tool calls resolve to the same canonical name and
      // render with the same specialized (e.g. diff/file-reference) content.
      return resolveLegacySnakeCaseToolName(toolName);
  }
}

function resolveLegacySnakeCaseToolName(
  toolName: string | null | undefined
): string | null {
  const trimmed = toolName?.trim() ?? "";
  if (!trimmed || !(trimmed in TOOL_ACTIVITY_KIND_TRANSLATION_KEYS)) {
    return null;
  }
  return legacyKindToToolName(trimmed as ToolActivityKind);
}

export function resolveLiveCanonicalToolName(
  item: WorkspaceAgentActivityTimelineItem,
  rawPayloadToolName: string | null | undefined,
  legacyACPToolName: string | null
): string | null | undefined {
  const itemName = (item.name ?? "").trim();
  if (
    rawPayloadToolName &&
    looksLikeOpaqueToolCallID(rawPayloadToolName, item)
  ) {
    return null;
  }
  if (
    rawPayloadToolName &&
    isCanonicalMcpToolName(rawPayloadToolName, item.callType, item.payload)
  ) {
    return rawPayloadToolName.trim();
  }
  if (!isLiveCanonicalToolCall(item) || !hasCanonicalACPPayload(item.payload)) {
    return undefined;
  }
  if (rawPayloadToolName) {
    if (
      !shouldFallBackToLegacyACPToolName(
        rawPayloadToolName,
        itemName,
        legacyACPToolName
      )
    ) {
      return rawPayloadToolName.trim();
    }
    return null;
  }
  const normalizedCallType = (
    item.callType ??
    stringPayloadValue(item.payload, "callType") ??
    ""
  )
    .trim()
    .toLowerCase();
  if (normalizedCallType === "tool" || normalizedCallType === "mcp") {
    return null;
  }
  return undefined;
}

function shouldFallBackToLegacyACPToolName(
  rawPayloadToolName: string,
  itemName: string,
  legacyACPToolName: string | null
): boolean {
  const trimmed = rawPayloadToolName.trim();
  if (!trimmed) {
    return false;
  }
  if (looksLikeOpaqueToolCallIdentifier(trimmed)) {
    return true;
  }
  if (legacyACPToolName === null) {
    return false;
  }
  if (trimmed === itemName) {
    return true;
  }
  return looksLikeOpaqueACPFunctionAlias(trimmed);
}

function looksLikeOpaqueACPFunctionAlias(value: string): boolean {
  return /^[A-Z][a-z0-9]{9,}$/.test(value);
}

function looksLikeOpaqueToolCallID(
  value: string,
  item: WorkspaceAgentActivityTimelineItem
): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  const payloadCallID =
    stringPayloadValue(item.payload, "callId") ??
    stringPayloadValue(item.payload, "callID") ??
    stringPayloadValue(item.payload, "call_id");
  if (trimmed === item.callId?.trim() || trimmed === payloadCallID?.trim()) {
    return true;
  }
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("call_")) {
    return isOpaqueIdentifierTail(trimmed.slice("call_".length));
  }
  if (lower.startsWith("ws_")) {
    return isOpaqueIdentifierTail(trimmed.slice("ws_".length));
  }
  return false;
}

function isOpaqueIdentifierTail(value: string): boolean {
  return value.length >= 12 && /^[a-z0-9]+$/i.test(value);
}

function isCanonicalMcpToolName(
  toolName: string,
  callType: string | undefined,
  payload: Record<string, unknown> | undefined
): boolean {
  const trimmed = toolName.trim();
  if (!trimmed) {
    return false;
  }
  if (trimmed.toLowerCase().startsWith("mcp__")) {
    return true;
  }
  const payloadCallType = stringPayloadValue(payload, "callType");
  return (
    (callType ?? "").trim().toLowerCase() === "mcp" ||
    (payloadCallType ?? "").trim().toLowerCase() === "mcp"
  );
}

function isLiveCanonicalToolCall(
  item: WorkspaceAgentActivityTimelineItem
): boolean {
  const itemType = item.itemType.trim().toLowerCase();
  return (
    itemType === "call.started" ||
    itemType === "call.completed" ||
    itemType === "call.errored"
  );
}

function hasCanonicalACPPayload(
  payload: Record<string, unknown> | undefined
): boolean {
  return Boolean(
    recordPayloadValue(payload, "acp") ||
    stringPayloadValue(payload, "sessionUpdate")
  );
}

function normalizeToolNameToken(value: string | null | undefined): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[_\s-]+/g, "");
}

function recordPayloadValue(
  value: Record<string, unknown> | undefined,
  key: string
): Record<string, unknown> | undefined {
  const nested = value?.[key];
  return nested && typeof nested === "object" && !Array.isArray(nested)
    ? (nested as Record<string, unknown>)
    : undefined;
}

function stringPayloadValue(
  value: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const nested = value?.[key];
  return typeof nested === "string" ? nested : undefined;
}
