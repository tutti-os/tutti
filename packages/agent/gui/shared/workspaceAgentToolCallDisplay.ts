import type { WorkspaceAgentActivityTimelineItem } from "./workspaceAgentActivityTypes";
import { translate } from "../i18n/index";
import {
  extractImageGenerationPreview,
  resolveImageGenerationCanonicalToolName
} from "./imageGenerationTool";
import { fileChangeCountFromChanges } from "./workspaceAgentFileChangePayload";
import {
  resolveCanonicalToolName,
  resolveLiveCanonicalToolName
} from "./workspaceAgentToolCallCanonical";
import { isAgentActivityTimelineItem } from "./workspaceAgentToolCallAgentActivity";
import { isOpaqueWorkspaceAgentToolCallIdentifier } from "./workspaceAgentToolCallIdentifiers";
import {
  AGENT_ACTIVITY_KINDS,
  TOOL_ACTIVITY_KIND_TRANSLATION_KEYS,
  TOOL_NAME_TRANSLATION_KEYS,
  legacyKindToToolName,
  type ToolActivityKind
} from "./workspaceAgentToolCallLabels";
export type { ToolActivityKind } from "./workspaceAgentToolCallLabels";
export type ToolCallStatusKind =
  | "working"
  | "completed"
  | "failed"
  | "canceled"
  | "waiting";

export interface WorkspaceAgentToolCallDisplay {
  id: string;
  name: string;
  status: string | null;
  statusKind: ToolCallStatusKind | null;
  detail?: string;
}

export function isWorkspaceAgentToolCallItem(
  item: WorkspaceAgentActivityTimelineItem
): boolean {
  const itemType = item.itemType.trim().toLowerCase();
  if (isAgentActivityTimelineItem(item)) {
    return false;
  }
  if (itemType === "call" || itemType.startsWith("call.")) {
    return true;
  }
  if (itemType.startsWith("approval.") || itemType.startsWith("interactive.")) {
    return true;
  }
  const payloadCallType = stringRecordValue(item.payload, "callType");
  if (payloadCallType === "approval" || payloadCallType === "interactive") {
    return true;
  }
  return isToolActivityTimelineItem(item);
}

export function buildWorkspaceAgentToolCallDisplay(
  item: WorkspaceAgentActivityTimelineItem
): WorkspaceAgentToolCallDisplay {
  const toolName = resolveWorkspaceAgentToolName(item);
  const detail = toolCallDetail(item, toolName);
  return {
    id: toolCallId(item),
    name: toolCallLabel(toolName),
    ...toolCallStatus(item),
    ...(detail ? { detail } : {})
  };
}

function toolCallId(item: WorkspaceAgentActivityTimelineItem): string {
  const metadata = recordValue(item.payload, "metadata");
  const callId = firstPresentString(
    stringRecordValue(item.payload, "callId"),
    stringRecordValue(item.payload, "callID"),
    stringRecordValue(item.payload, "call_id"),
    stringRecordValue(metadata, "callId"),
    stringRecordValue(metadata, "callID"),
    stringRecordValue(metadata, "call_id"),
    item.callId
  );
  return callId ? `call:${callId}` : itemId(item);
}

export function resolveWorkspaceAgentToolName(
  item: WorkspaceAgentActivityTimelineItem
): string | null {
  const metadata = recordValue(item.payload, "metadata");
  const input = recordValue(item.payload, "input");
  const output = recordValue(item.payload, "output");
  const rawPayloadToolName = firstPresentString(
    stringRecordValue(item.payload, "toolName"),
    stringRecordValue(metadata, "toolName"),
    claudeCodeToolName(input),
    claudeCodeToolName(output)
  );
  const imageGenerationToolName = resolveImageGenerationCanonicalToolName({
    toolName: rawPayloadToolName,
    displayName: item.name,
    content: item.payload?.content,
    outputContent: output?.content,
    inputPrompt: input?.prompt
  });
  if (imageGenerationToolName) {
    return imageGenerationToolName;
  }
  const canonicalToolName = resolveCanonicalToolName(rawPayloadToolName);
  if (canonicalToolName) {
    return canonicalToolName;
  }
  const liveCanonicalToolName = resolveLiveCanonicalToolName(
    item,
    rawPayloadToolName,
    resolveLegacyACPToolName(item)
  );
  if (
    typeof liveCanonicalToolName === "string" &&
    liveCanonicalToolName.trim()
  ) {
    return liveCanonicalToolName;
  }
  if (liveCanonicalToolName === null && !rawPayloadToolName) {
    return null;
  }
  return resolveLegacyToolName(item) ?? resolveLegacyNamedToolName(item);
}

function resolveFetchToolName(
  payload: Record<string, unknown> | undefined
): string | null {
  const input = recordValue(payload, "input");
  const action = recordValue(input, "action");
  const actionType = normalizeToolToken(stringRecordValue(action, "type"));
  switch (actionType) {
    case "search":
    case "search_query":
    case "web_search":
      return "WebSearch";
    case "open_page":
    case "open":
    case "fetch":
    case "web_fetch":
      return "WebFetch";
    default:
      break;
  }
  if (
    firstPresentString(
      stringRecordValue(action, "url"),
      stringRecordValue(input, "url")
    )
  ) {
    return "WebFetch";
  }
  if (
    firstPresentString(
      stringRecordValue(action, "query"),
      stringRecordValue(input, "query"),
      stringRecordValue(input, "search_query"),
      stringRecordValue(input, "searchQuery")
    )
  ) {
    return "WebSearch";
  }
  return null;
}

function resolveLegacyToolName(
  item: WorkspaceAgentActivityTimelineItem
): string | null {
  const metadata = recordValue(item.payload, "metadata");
  const rawKind =
    stringRecordValue(item.payload, "activityKind") ??
    stringRecordValue(item.payload, "activity_kind") ??
    stringRecordValue(metadata, "activityKind") ??
    stringRecordValue(metadata, "activity_kind");
  const normalizedKind = normalizeToolToken(rawKind);
  if (AGENT_ACTIVITY_KINDS.has(normalizedKind as ToolActivityKind)) {
    return null;
  }
  if (isToolActivityKind(normalizedKind)) {
    return legacyKindToToolName(normalizedKind);
  }

  return resolveLegacyACPToolName(item);
}

function resolveLegacyACPToolName(
  item: WorkspaceAgentActivityTimelineItem
): string | null {
  const normalizedKind = normalizeToolToken(
    stringRecordValue(item.payload, "kind")
  );
  const normalizedTitle = normalizeToolToken(
    firstPresentString(stringRecordValue(item.payload, "title"), item.name)
  );
  const input = recordValue(item.payload, "input");
  const fetchToolName = resolveFetchToolName(item.payload);

  if (fetchToolName) {
    return fetchToolName;
  }

  if (normalizedKind === "fetch") {
    return "WebFetch";
  }
  if (normalizedKind === "read") {
    return stringRecordValue(input, "pattern") ? "Glob" : "Read";
  }
  if (normalizedKind === "think") {
    return normalizedTitle === "update_todo" || Array.isArray(input?.todos)
      ? "TodoWrite"
      : "Think";
  }
  if (normalizedKind === "search") {
    switch (normalizedTitle) {
      case "glob":
      case "find":
      case "fd":
      case "file_search":
        return "Glob";
      case "grep":
      case "rg":
      case "ripgrep":
      case "codebase_search":
        return "Grep";
      default:
        return "Bash";
    }
  }
  if (normalizedKind === "other") {
    switch (normalizedTitle) {
      case "task":
      case "subagent":
      case "runsubagent":
      case "delegatetask":
      case "delegateagent":
      case "agent":
        return "Agent";
      case "rg":
      case "ripgrep":
        return "Grep";
      case "find":
      case "fd":
        return "Glob";
      default:
        return null;
    }
  }
  switch (normalizedKind) {
    case "execute":
    case "exec":
    case "command":
    case "shell":
      return "Bash";
    case "edit":
    case "move":
      return "Edit";
    case "delete":
      return "Write";
    default:
      return null;
  }
}

function resolveLegacyNamedToolName(
  item: WorkspaceAgentActivityTimelineItem
): string | null {
  const metadata = recordValue(item.payload, "metadata");
  const rawTitle = firstPresentString(
    stringRecordValue(item.payload, "tool"),
    stringRecordValue(metadata, "tool"),
    item.name
  );
  if (looksLikeOpaqueToolCallID(rawTitle, item)) {
    return null;
  }
  const normalizedTitle = normalizeToolNameToken(rawTitle);
  switch (normalizedTitle) {
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
    case "bash":
    case "shell":
    case "exec":
    case "execcommand":
    case "runshellcommand":
      return "Bash";
    case "read":
    case "readfile":
      return "Read";
    case "write":
    case "writefile":
      return "Write";
    case "edit":
    case "editfile":
    case "multiedit":
      return "Edit";
    case "grep":
      return "Grep";
    case "glob":
      return "Glob";
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
    case "agent":
      return "Agent";
    default:
      break;
  }

  const lowerTitle = rawTitle.trim().toLowerCase();
  if (lowerTitle.startsWith("read ")) {
    return "Read";
  }
  if (lowerTitle.startsWith("write ")) {
    return "Write";
  }
  if (lowerTitle.startsWith("edit ")) {
    return "Edit";
  }

  if (
    !normalizedTitle ||
    isGenericToolLabel(normalizedTitle) ||
    isOpaqueWorkspaceAgentToolCallIdentifier(rawTitle, item)
  ) {
    return null;
  }
  return rawTitle.trim();
}

function toolCallStatus(item: WorkspaceAgentActivityTimelineItem): {
  status: string | null;
  statusKind: ToolCallStatusKind | null;
} {
  const payloadStatus = firstPresentString(
    item.status,
    stringRecordValue(item.payload, "status"),
    stringRecordValue(item.payload, "activityStatus"),
    statusFromActivityEventType(activityEventType(item))
  );
  switch (normalizeToolToken(payloadStatus)) {
    case "active":
    case "running":
    case "working":
      return {
        status: translate("agentHost.agentTool.statusWorking"),
        statusKind: "working"
      };
    case "completed":
    case "done":
    case "success":
    case "succeeded":
      return {
        status: translate("agentHost.agentTool.statusCompleted"),
        statusKind: "completed"
      };
    case "failed":
    case "error":
      return {
        status: translate("agentHost.agentTool.statusFailed"),
        statusKind: "failed"
      };
    case "canceled":
      return {
        status: translate("agentHost.agentTool.statusCanceled"),
        statusKind: "canceled"
      };
    case "pending":
    case "waiting":
    case "awaiting_approval":
    case "waiting_approval":
    case "waiting_input":
      return {
        status: translate("agentHost.agentTool.statusWaiting"),
        statusKind: "waiting"
      };
    default:
      return { status: null, statusKind: null };
  }
}

function toolCallDetail(
  item: WorkspaceAgentActivityTimelineItem,
  toolName: string | null
): string | null {
  const metadata = recordValue(item.payload, "metadata");
  const metadataInput = recordValue(metadata, "input");
  const metadataError = recordValue(metadata, "error");
  const payloadInput = recordValue(item.payload, "input");
  const payloadOutput = recordValue(item.payload, "output");
  const payloadError = recordValue(item.payload, "error");
  const paths = collectToolPaths(metadata, metadataInput, payloadInput);
  const rawToolName = firstPresentString(
    stringRecordValue(metadata, "tool"),
    stringRecordValue(item.payload, "tool"),
    toolNameFromActivityKey(toolActivityKey(item)),
    item.name
  );
  const visibleRawToolName = isOpaqueWorkspaceAgentToolCallIdentifier(
    rawToolName,
    item
  )
    ? ""
    : rawToolName;
  const fallback = firstPresentString(
    commandDetail(
      item.payload,
      metadata,
      metadataInput,
      metadataError,
      payloadInput,
      payloadError
    ),
    toolContentDetail(
      item.payload,
      metadata,
      metadataInput,
      metadataError,
      payloadInput,
      payloadError
    ),
    item.content,
    stringRecordValue(item.payload, "summary"),
    stringRecordValue(item.payload, "content"),
    stringRecordValue(item.payload, "text"),
    stringRecordValue(metadata, "summary")
  );
  const query = firstPresentString(
    stringRecordValue(item.payload, "query"),
    stringArrayFirstRecordValue(item.payload, "search_query"),
    stringArrayFirstRecordValue(item.payload, "searchQuery"),
    stringRecordValue(metadata, "query"),
    stringRecordValue(metadataInput, "query"),
    stringArrayFirstRecordValue(metadataInput, "search_query"),
    stringArrayFirstRecordValue(metadataInput, "searchQuery"),
    stringRecordValue(payloadInput, "query"),
    stringArrayFirstRecordValue(payloadInput, "search_query"),
    stringArrayFirstRecordValue(payloadInput, "searchQuery"),
    stringRecordValue(recordValue(payloadInput, "action"), "query"),
    stringRecordValue(recordValue(payloadInput, "action"), "url")
  );
  const webTarget = firstPresentString(
    query,
    stringRecordValue(metadataInput, "url"),
    stringRecordValue(payloadInput, "url")
  );
  const pattern = firstPresentString(
    stringRecordValue(item.payload, "pattern"),
    stringRecordValue(metadata, "pattern"),
    stringRecordValue(metadataInput, "pattern"),
    stringRecordValue(payloadInput, "pattern")
  );
  const command = firstPresentString(
    stringRecordValue(metadata, "command"),
    stringRecordValue(metadataInput, "cmd"),
    stringRecordValue(metadataInput, "command"),
    stringRecordValue(payloadInput, "cmd"),
    stringRecordValue(payloadInput, "command")
  );
  const path = firstPresentString(
    stringRecordValue(metadataInput, "path"),
    stringRecordValue(metadataInput, "file_path"),
    stringRecordValue(metadataInput, "fileName"),
    stringRecordValue(metadataInput, "filename"),
    stringRecordValue(payloadInput, "path"),
    stringRecordValue(payloadInput, "file_path"),
    stringRecordValue(payloadInput, "fileName"),
    stringRecordValue(payloadInput, "filename")
  );
  const inputSummary = firstPresentString(
    summarizeToolInput(metadataInput),
    summarizeToolInput(payloadInput)
  );
  const normalizedToolName = normalizeToolNameToken(toolName);
  const multiFileSummary = summarizeFileChangeCount(
    payloadOutput,
    payloadInput,
    item.payload,
    metadataInput
  );
  const todoSummary = summarizeTodoProgress(payloadInput);
  const webDomainSummary = summarizeWebDomain(webTarget);
  const imageGeneration = extractImageGenerationPreview({
    toolName,
    displayName: visibleRawToolName,
    content: item.payload?.content,
    outputContent: payloadOutput?.content,
    inputPrompt: payloadInput?.prompt,
    payloadInputPrompt: metadataInput?.prompt
  });

  switch (normalizedToolName) {
    case "imagegeneration":
      return (
        imageGeneration.prompt ||
        imageGeneration.imageUri ||
        fallback ||
        inputSummary ||
        null
      );
    case "read":
    case "write":
    case "edit":
    case "multiedit":
      return (
        multiFileSummary ||
        path ||
        firstPath(paths) ||
        fallback ||
        inputSummary ||
        command ||
        null
      );
    case "glob":
      return (
        pattern ||
        query ||
        path ||
        firstPath(paths) ||
        fallback ||
        inputSummary ||
        null
      );
    case "bash":
      return (
        command || path || firstPath(paths) || fallback || inputSummary || null
      );
    case "grep":
      return (
        query ||
        pattern ||
        fallback ||
        inputSummary ||
        command ||
        firstPath(paths) ||
        null
      );
    case "websearch":
      return (
        query ||
        webDomainSummary ||
        pattern ||
        fallback ||
        inputSummary ||
        command ||
        firstPath(paths) ||
        null
      );
    case "webfetch":
      return (
        webDomainSummary ||
        query ||
        pattern ||
        fallback ||
        inputSummary ||
        command ||
        firstPath(paths) ||
        null
      );
    case "todowrite":
      return todoSummary || inputSummary || fallback || null;
    case "toolsearch":
    case "skill":
    case "task":
    case "agent":
      return (
        inputSummary ||
        fallback ||
        path ||
        firstPath(paths) ||
        query ||
        pattern ||
        command ||
        visibleRawToolName ||
        null
      );
    default:
      return (
        fallback ||
        command ||
        path ||
        firstPath(paths) ||
        query ||
        pattern ||
        inputSummary ||
        visibleRawToolName ||
        null
      );
  }
}

function commandDetail(
  payload: Record<string, unknown> | undefined,
  metadata: Record<string, unknown> | undefined,
  metadataInput: Record<string, unknown> | undefined,
  metadataError: Record<string, unknown> | undefined,
  payloadInput: Record<string, unknown> | undefined,
  payloadError: Record<string, unknown> | undefined
): string {
  const payloadRawInput = recordValue(payloadInput, "rawInput");
  return firstPresentString(
    stringRecordValue(payload, "command"),
    stringRecordValue(payload, "cmd"),
    stringRecordValue(metadata, "command"),
    stringRecordValue(metadata, "cmd"),
    stringRecordValue(metadataInput, "cmd"),
    stringRecordValue(metadataInput, "command"),
    stringRecordValue(metadataError, "cmd"),
    stringRecordValue(metadataError, "command"),
    stringRecordValue(payloadInput, "cmd"),
    stringRecordValue(payloadInput, "command"),
    stringRecordValue(payloadRawInput, "cmd"),
    stringRecordValue(payloadRawInput, "command"),
    stringRecordValue(payloadError, "cmd"),
    stringRecordValue(payloadError, "command")
  );
}

function claudeCodeToolName(
  value: Record<string, unknown> | undefined
): string | undefined {
  const meta = recordValue(value, "_meta");
  const claudeCode = recordValue(meta, "claudeCode");
  return stringRecordValue(claudeCode, "toolName");
}

function toolContentDetail(
  payload: Record<string, unknown> | undefined,
  metadata: Record<string, unknown> | undefined,
  metadataInput: Record<string, unknown> | undefined,
  metadataError: Record<string, unknown> | undefined,
  payloadInput: Record<string, unknown> | undefined,
  payloadError: Record<string, unknown> | undefined
): string {
  return firstPresentString(
    stringRecordValue(payload, "query"),
    stringRecordValue(payload, "search_query"),
    stringRecordValue(payload, "searchQuery"),
    stringRecordValue(payload, "pattern"),
    stringRecordValue(payload, "glob"),
    stringRecordValue(payload, "regex"),
    stringRecordValue(payload, "url"),
    stringRecordValue(payload, "patch"),
    stringRecordValue(metadata, "query"),
    stringRecordValue(metadata, "pattern"),
    stringRecordValue(metadata, "glob"),
    stringRecordValue(metadata, "regex"),
    stringRecordValue(metadata, "url"),
    stringRecordValue(metadata, "patch"),
    stringRecordValue(metadataInput, "query"),
    stringRecordValue(metadataInput, "pattern"),
    stringRecordValue(metadataInput, "glob"),
    stringRecordValue(metadataInput, "regex"),
    stringRecordValue(metadataInput, "url"),
    stringRecordValue(metadataInput, "patch"),
    stringRecordValue(metadataError, "query"),
    stringRecordValue(metadataError, "pattern"),
    stringRecordValue(metadataError, "url"),
    stringRecordValue(payloadInput, "query"),
    stringRecordValue(payloadInput, "search_query"),
    stringRecordValue(payloadInput, "searchQuery"),
    stringRecordValue(payloadInput, "pattern"),
    stringRecordValue(payloadInput, "glob"),
    stringRecordValue(payloadInput, "regex"),
    stringRecordValue(payloadInput, "url"),
    stringRecordValue(payloadInput, "patch"),
    stringRecordValue(payloadError, "query"),
    stringRecordValue(payloadError, "pattern"),
    stringRecordValue(payloadError, "url")
  );
}

function isToolActivityTimelineItem(
  item: WorkspaceAgentActivityTimelineItem
): boolean {
  const eventType = activityEventType(item);
  if (!eventType.startsWith("activity.")) {
    return false;
  }
  const activityKey = toolActivityKey(item);
  if (activityKey.startsWith("tool.")) {
    return true;
  }
  return resolveLegacyToolName(item) !== null;
}

function activityEventType(item: WorkspaceAgentActivityTimelineItem): string {
  const itemType = item.itemType.trim().toLowerCase();
  if (itemType.startsWith("activity.")) {
    return itemType;
  }
  return firstPresentString(
    stringRecordValue(item.payload, "eventKey"),
    item.itemType
  )
    .trim()
    .toLowerCase();
}

function statusFromActivityEventType(eventType: string): string {
  switch (eventType) {
    case "activity.started":
    case "call.started":
      return "running";
    case "activity.completed":
    case "call.completed":
      return "completed";
    case "activity.failed":
    case "call.failed":
    case "call.errored":
      return "failed";
    default:
      return "";
  }
}

function toolActivityKey(item: WorkspaceAgentActivityTimelineItem): string {
  const metadata = recordValue(item.payload, "metadata");
  return firstPresentString(
    stringRecordValue(item.payload, "activityKey"),
    stringRecordValue(item.payload, "activity_key"),
    stringRecordValue(metadata, "activityKey"),
    stringRecordValue(metadata, "activity_key")
  )
    .trim()
    .toLowerCase();
}

function toolNameFromActivityKey(activityKey: string): string {
  return activityKey.startsWith("tool.")
    ? activityKey.slice("tool.".length)
    : "";
}

function isToolActivityKind(value: string): value is ToolActivityKind {
  return value in TOOL_ACTIVITY_KIND_TRANSLATION_KEYS;
}

function normalizeToolToken(value: string | undefined): string {
  return (
    value
      ?.trim()
      .toLowerCase()
      .replace(/[-\s]+/gu, "_") ?? ""
  );
}

function recordValue(
  value: Record<string, unknown> | undefined,
  key: string
): Record<string, unknown> | undefined {
  const nested = value?.[key];
  return nested && typeof nested === "object" && !Array.isArray(nested)
    ? (nested as Record<string, unknown>)
    : undefined;
}

function stringRecordValue(
  value: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const nested = value?.[key];
  return typeof nested === "string" ? nested : undefined;
}

function stringArrayRecordValue(
  value: Record<string, unknown> | undefined,
  key: string
): string[] {
  const nested = value?.[key];
  if (!Array.isArray(nested)) {
    return [];
  }
  return nested.flatMap((item) =>
    typeof item === "string" && item.trim() ? [item.trim()] : []
  );
}

function stringArrayFirstRecordValue(
  value: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  return stringArrayRecordValue(value, key)[0];
}

function arrayRecordValue(
  value: Record<string, unknown> | undefined,
  key: string
): Array<Record<string, unknown>> {
  const nested = value?.[key];
  if (!Array.isArray(nested)) {
    return [];
  }
  return nested.flatMap((item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? [item as Record<string, unknown>]
      : []
  );
}

function collectToolPaths(
  metadata: Record<string, unknown> | undefined,
  metadataInput: Record<string, unknown> | undefined,
  payloadInput: Record<string, unknown> | undefined
): string[] {
  const values = [
    ...stringArrayRecordValue(metadata, "paths"),
    ...toolInputPaths(metadataInput),
    ...toolInputPaths(payloadInput)
  ];
  return Array.from(new Set(values));
}

function toolInputPaths(value: Record<string, unknown> | undefined): string[] {
  if (!value) {
    return [];
  }
  return [
    ...stringValues(
      value,
      "path",
      "file_path",
      "filePath",
      "filepath",
      "fileName",
      "filename",
      "target_path",
      "targetPath"
    ),
    ...stringArrayRecordValue(value, "paths"),
    ...stringArrayRecordValue(value, "file_paths"),
    ...stringArrayRecordValue(value, "filePaths"),
    ...stringArrayRecordValue(value, "file_names"),
    ...stringArrayRecordValue(value, "fileNames"),
    ...stringArrayRecordValue(value, "filenames")
  ];
}

function summarizeToolInput(
  value: Record<string, unknown> | undefined
): string {
  if (!value) {
    return "";
  }

  for (const key of [
    "path",
    "file_path",
    "filePath",
    "filepath",
    "fileName",
    "filename",
    "target_path",
    "targetPath",
    "url",
    "uri",
    "query",
    "pattern",
    "prompt",
    "instruction",
    "task",
    "title",
    "message",
    "text",
    "cmd",
    "command"
  ]) {
    const text = summarizeInputField(value, key);
    if (text) {
      return text;
    }
  }

  for (const [key, fieldValue] of Object.entries(value)) {
    if (isSensitiveKey(key)) {
      continue;
    }
    const text = summarizeInputValue(key, fieldValue);
    if (text) {
      return text;
    }
  }

  return "";
}

function summarizeFileChangeCount(
  ...values: Array<Record<string, unknown> | undefined>
): string | null {
  for (const value of values) {
    const structuredPatch = arrayRecordValue(value, "structuredPatch");
    if (structuredPatch.length > 1) {
      return `${structuredPatch.length} files`;
    }
    const fileChanges = arrayRecordValue(
      recordValue(value, "fileChanges"),
      "files"
    );
    if (fileChanges.length > 1) {
      return `${fileChanges.length} files`;
    }
    const changesCount = fileChangeCountFromChanges(value?.changes);
    if (changesCount > 1) {
      return `${changesCount} files`;
    }
  }
  return null;
}

function summarizeTodoProgress(
  value: Record<string, unknown> | undefined
): string | null {
  const todos = arrayRecordValue(value, "todos");
  if (todos.length === 0) {
    return null;
  }
  const completed = todos.filter(
    (todo) =>
      normalizeToolToken(stringRecordValue(todo, "status")) === "completed"
  ).length;
  return `${completed}/${todos.length} completed`;
}

function summarizeWebDomain(value: string | null): string | null {
  if (!value) {
    return null;
  }
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function summarizeInputField(
  value: Record<string, unknown>,
  key: string
): string {
  const fieldValue = value[key];
  if (typeof fieldValue === "string") {
    return formatInputSummary(key, fieldValue);
  }
  if (Array.isArray(fieldValue)) {
    const items = fieldValue
      .flatMap((item) =>
        typeof item === "string" && item.trim() ? [item.trim()] : []
      )
      .slice(0, 3);
    if (items.length > 0) {
      return formatInputSummary(key, items.join(", "));
    }
  }
  if (
    fieldValue &&
    typeof fieldValue === "object" &&
    !Array.isArray(fieldValue)
  ) {
    for (const [nestedKey, nestedValue] of Object.entries(
      fieldValue as Record<string, unknown>
    )) {
      if (isSensitiveKey(nestedKey)) {
        continue;
      }
      const text = summarizeInputValue(`${key}.${nestedKey}`, nestedValue);
      if (text) {
        return text;
      }
    }
  }
  return "";
}

function summarizeInputValue(key: string, value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    return "";
  }
  return formatInputSummary(key, value);
}

function formatInputSummary(key: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  const normalizedKey = normalizeToolToken(key);
  const prefixlessKeys = new Set(
    [
      "path",
      "file_path",
      "filePath",
      "filepath",
      "fileName",
      "filename",
      "target_path",
      "targetPath",
      "url",
      "uri",
      "query",
      "pattern",
      "cmd",
      "command"
    ].map((token) => normalizeToolToken(token))
  );
  const text = truncateSummary(trimmed);
  // i18n-check-ignore: Tool input summaries combine schema keys with user input.
  return prefixlessKeys.has(normalizedKey) ? text : `${key}: ${text}`;
}

function truncateSummary(value: string, limit = 140): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

function isSensitiveKey(key: string): boolean {
  const normalized = normalizeToolToken(key);
  return (
    normalized.includes("token") ||
    normalized.includes("password") ||
    normalized.includes("secret") ||
    normalized.includes("api_key") ||
    normalized.includes("apikey") ||
    normalized.includes("authorization")
  );
}

function stringValues(
  value: Record<string, unknown>,
  ...keys: string[]
): string[] {
  return keys.flatMap((key) => {
    const text = stringRecordValue(value, key)?.trim();
    return text ? [text] : [];
  });
}

function firstPath(paths: string[]): string {
  return paths[0] ?? "";
}

function firstPresentString(
  ...values: Array<string | null | undefined>
): string {
  for (const value of values) {
    const normalized = value?.trim();
    if (normalized) {
      return normalized;
    }
  }
  return "";
}

function itemId(item: WorkspaceAgentActivityTimelineItem): string {
  return item.eventId.trim() || `id:${item.id}`;
}

function isGenericToolLabel(normalizedTitle: string): boolean {
  return normalizedTitle === "tool" || normalizedTitle === "usetool";
}

function looksLikeOpaqueToolCallID(
  value: string | null,
  item: WorkspaceAgentActivityTimelineItem
): boolean {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return false;
  }
  const metadata = recordValue(item.payload, "metadata");
  const callID = firstPresentString(
    item.callId,
    stringRecordValue(item.payload, "callId"),
    stringRecordValue(item.payload, "callID"),
    stringRecordValue(item.payload, "call_id"),
    stringRecordValue(metadata, "callId"),
    stringRecordValue(metadata, "callID"),
    stringRecordValue(metadata, "call_id")
  );
  if (callID && trimmed === callID) {
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

function toolCallLabel(toolName: string | null): string {
  const normalized = normalizeToolNameToken(toolName);
  const translationKey = normalized
    ? TOOL_NAME_TRANSLATION_KEYS[normalized]
    : null;
  if (translationKey) {
    return translate(translationKey);
  }
  if (toolName?.trim()) {
    return humanizeToolName(toolName);
  }
  return translate("agentHost.agentTool.fallbackName");
}

function normalizeToolNameToken(value: string | null | undefined): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[_\s-]+/gu, "");
}

function humanizeToolName(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}
