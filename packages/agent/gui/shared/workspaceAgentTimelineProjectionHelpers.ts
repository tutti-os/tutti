import type { WorkspaceAgentActivityTimelineItem } from "./workspaceAgentTimelineTypes";
import {
  buildWorkspaceAgentToolCallDisplay,
  resolveWorkspaceAgentToolName,
  type ToolCallStatusKind
} from "./workspaceAgentToolCallDisplay";
import type {
  BuildWorkspaceAgentSessionDetailInput,
  WorkspaceAgentSessionDetailMessage,
  WorkspaceAgentSessionDetailToolCall,
  WorkspaceAgentSessionDetailTurn
} from "./workspaceAgentSessionDetailViewModel";

export function delegatedToolStepFromCall(
  call: WorkspaceAgentSessionDetailToolCall
): Record<string, unknown> {
  const payload = normalizedPayload(call.payload ?? undefined);
  return {
    id: call.id,
    toolUseId: call.id.replace(/^call:/, ""),
    name: call.name,
    toolName: call.toolName,
    callType: call.callType,
    status: call.status,
    toolInput: normalizedPayload(
      payload?.input as WorkspaceAgentActivityTimelineItem["payload"]
    ),
    toolResult: normalizedPayload(
      payload?.output as WorkspaceAgentActivityTimelineItem["payload"]
    ),
    toolError: normalizedPayload(
      payload?.error as WorkspaceAgentActivityTimelineItem["payload"]
    ),
    payload,
    metadata: normalizedPayload(
      payload?.metadata as WorkspaceAgentActivityTimelineItem["payload"]
    ),
    content: Array.isArray(payload?.content) ? payload.content : null,
    locations: Array.isArray(payload?.locations) ? payload.locations : null,
    occurredAtUnixMs: call.occurredAtUnixMs ?? null
  };
}

export function compareToolCallsAscending(
  left: WorkspaceAgentSessionDetailToolCall,
  right: WorkspaceAgentSessionDetailToolCall
): number {
  return (
    (left.occurredAtUnixMs ?? 0) - (right.occurredAtUnixMs ?? 0) ||
    left.id.localeCompare(right.id)
  );
}

export function parentToolUseIdFromCall(
  call: WorkspaceAgentSessionDetailToolCall
): string | null {
  const metadata = normalizedPayload(
    call.payload?.metadata as WorkspaceAgentActivityTimelineItem["payload"]
  );
  const input = normalizedPayload(
    call.payload?.input as WorkspaceAgentActivityTimelineItem["payload"]
  );
  const output = normalizedPayload(
    call.payload?.output as WorkspaceAgentActivityTimelineItem["payload"]
  );
  const error = normalizedPayload(
    call.payload?.error as WorkspaceAgentActivityTimelineItem["payload"]
  );
  return firstPresentString(
    stringRecordValue(metadata, "parentToolUseId"),
    stringRecordValue(call.payload, "parentToolUseId"),
    claudeCodeMetaValue(input, "parentToolUseId"),
    claudeCodeMetaValue(output, "parentToolUseId"),
    claudeCodeMetaValue(error, "parentToolUseId")
  );
}

export function isTaskLikeToolCall(
  call: WorkspaceAgentSessionDetailToolCall
): boolean {
  return [
    "task",
    "subagent",
    "delegatetask",
    "delegateagent",
    "agent"
  ].includes(normalizeToolName(call.toolName));
}

export function toolCallView(
  item: WorkspaceAgentActivityTimelineItem
): WorkspaceAgentSessionDetailToolCall {
  const display = buildWorkspaceAgentToolCallDisplay(item);
  const preserveTitle =
    item.itemType.trim().toLowerCase().startsWith("approval.") ||
    item.itemType.trim().toLowerCase().startsWith("interactive.") ||
    firstPresentString(
      item.callType,
      stringRecordValue(item.payload, "callType")
    ) === "approval";
  const fallbackName = preserveTitle
    ? firstPresentString(item.name, display.name)
    : display.name;
  return withSourceTimelineItems(
    {
      id: display.id,
      name: fallbackName || display.name,
      toolName: resolveWorkspaceAgentToolName(item),
      callType: firstPresentString(
        item.callType,
        stringRecordValue(item.payload, "callType")
      ),
      status: display.status,
      statusKind: display.statusKind,
      summary: display.detail ?? "",
      payload: normalizedPayload(item.payload),
      turnId: item.turnId?.trim() || undefined,
      compactSummary: display.detail ?? "",
      occurredAtUnixMs: item.occurredAtUnixMs ?? item.createdAtUnixMs ?? null
    },
    [item]
  );
}

export function withSourceTimelineItems<T extends object>(
  value: T,
  sourceTimelineItems: readonly WorkspaceAgentActivityTimelineItem[] | undefined
): T & { sourceTimelineItems?: WorkspaceAgentActivityTimelineItem[] } {
  if (!sourceTimelineItems || sourceTimelineItems.length === 0) return value;
  Object.defineProperty(value, "sourceTimelineItems", {
    configurable: true,
    enumerable: false,
    value: [...sourceTimelineItems],
    writable: true
  });
  return value as T & {
    sourceTimelineItems?: WorkspaceAgentActivityTimelineItem[];
  };
}

export function mergeSourceTimelineItems(
  previous: readonly WorkspaceAgentActivityTimelineItem[] | undefined,
  next: readonly WorkspaceAgentActivityTimelineItem[] | undefined
): WorkspaceAgentActivityTimelineItem[] | undefined {
  const merged = [...(previous ?? []), ...(next ?? [])];
  if (merged.length === 0) return undefined;
  const byKey = new Map<string, WorkspaceAgentActivityTimelineItem>();
  for (const item of merged) byKey.set(sourceTimelineItemKey(item), item);
  return [...byKey.values()].sort(compareTimelineItemsAscending);
}

export function normalizedPayload(
  payload: WorkspaceAgentActivityTimelineItem["payload"]
): Record<string, unknown> | null {
  return payload && typeof payload === "object" ? payload : null;
}

export function visibleErrorFromPayload(
  payload: Record<string, unknown> | null
): WorkspaceAgentSessionDetailMessage["visibleError"] {
  if (stringRecordValue(payload, "kind") !== "agent_visible_error") return null;
  return {
    code: stringRecordValue(payload, "code"),
    phase: stringRecordValue(payload, "phase"),
    provider: stringRecordValue(payload, "provider"),
    detail: stringRecordValue(payload, "detail"),
    retryable: booleanRecordValue(payload, "retryable")
  };
}

export function systemNoticeFromPayload(
  payload: Record<string, unknown> | null
): WorkspaceAgentSessionDetailMessage["systemNotice"] {
  if (stringRecordValue(payload, "kind") !== "agent_system_notice") return null;
  const source = stringRecordValue(payload, "source");
  return {
    noticeKind: stringRecordValue(payload, "noticeKind"),
    severity: stringRecordValue(payload, "severity"),
    ...(source ? { source } : {}),
    title: stringRecordValue(payload, "title"),
    detail: stringRecordValue(payload, "detail"),
    retryable: booleanRecordValue(payload, "retryable")
  };
}

export function stringRecordValue(record: unknown, key: string): string | null {
  if (!record || typeof record !== "object" || Array.isArray(record))
    return null;
  const value = (record as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function claudeCodeMetaValue(
  record: Record<string, unknown> | null,
  key: string
): string | null {
  const meta = normalizedPayload(
    record?._meta as WorkspaceAgentActivityTimelineItem["payload"]
  );
  const claudeCode = normalizedPayload(
    meta?.claudeCode as WorkspaceAgentActivityTimelineItem["payload"]
  );
  return stringRecordValue(claudeCode, key);
}

export function firstPresentString(
  ...values: Array<string | null | undefined>
): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

export function summarizeToolCallGroup(
  calls: readonly WorkspaceAgentSessionDetailToolCall[]
): string | null {
  if (calls.length < 2) return null;
  const targets = [
    ...new Set(
      calls
        .filter((call) =>
          ["edit", "multiedit", "write"].includes(
            normalizeToolName(call.toolName)
          )
        )
        .map((call) => summarizeCallTarget(call.summary))
        .filter((value): value is string => value !== null)
    )
  ];
  if (targets.length === 0) return null;
  return targets.length === 1
    ? `Changed ${targets[0]}`
    : `Changed ${targets[0]} and ${targets.length - 1} more files`;
}

export function shouldShowProcessingIndicator(
  session: BuildWorkspaceAgentSessionDetailInput["session"],
  turns: readonly WorkspaceAgentSessionDetailTurn[]
): boolean {
  if (!sessionHasRunnableIndicatorState(session)) return false;
  const lastTurn = turns.at(-1);
  if (!lastTurn) return true;
  const lastAgentItem = lastTurn.agentItems.at(-1);
  if (
    lastAgentItem?.kind === "message" &&
    isTerminalAgentMessageStatus(lastAgentItem.message.statusKind) &&
    !hasActiveRunningTurn(session)
  ) {
    return false;
  }
  return !lastTurn.toolCalls.some(
    (call) => call.statusKind === "working" || call.statusKind === "waiting"
  );
}

function sourceTimelineItemKey(
  item: WorkspaceAgentActivityTimelineItem
): string {
  const eventId = item.eventId?.trim();
  if (eventId) return `event:${eventId}`;
  if (Number.isFinite(item.id) && item.id > 0) return `id:${item.id}`;
  const seq = item.seq ?? 0;
  return seq > 0
    ? `seq:${seq}`
    : `local:${item.itemType}:${item.occurredAtUnixMs ?? 0}`;
}

function compareTimelineItemsAscending(
  left: WorkspaceAgentActivityTimelineItem,
  right: WorkspaceAgentActivityTimelineItem
): number {
  return (
    (left.seq ?? 0) - (right.seq ?? 0) ||
    (left.occurredAtUnixMs ?? left.createdAtUnixMs ?? 0) -
      (right.occurredAtUnixMs ?? right.createdAtUnixMs ?? 0) ||
    left.id - right.id
  );
}

function booleanRecordValue(record: unknown, key: string): boolean | null {
  if (!record || typeof record !== "object" || Array.isArray(record))
    return null;
  const value = (record as Record<string, unknown>)[key];
  return typeof value === "boolean" ? value : null;
}

function normalizeToolName(name: string | null): string {
  return (name ?? "")
    .trim()
    .replace(/[_\s-]+/g, "")
    .toLowerCase();
}

function summarizeCallTarget(summary: string): string | null {
  const firstLine = summary.trim().split("\n")[0]?.trim() ?? "";
  if (!firstLine) return null;
  return firstLine.split(/[\\/]/).filter(Boolean).at(-1) ?? firstLine;
}

function hasActiveRunningTurn(
  session: BuildWorkspaceAgentSessionDetailInput["session"]
): boolean {
  const activeTurn = session.activeTurn;
  return Boolean(activeTurn && activeTurn.phase !== "settled");
}

function sessionHasRunnableIndicatorState(
  session: BuildWorkspaceAgentSessionDetailInput["session"]
): boolean {
  return session.activeTurn ? session.activeTurn.phase !== "settled" : false;
}

function isTerminalAgentMessageStatus(
  status: ToolCallStatusKind | null | undefined
): boolean {
  return status === "completed" || status === "failed" || status === "canceled";
}
