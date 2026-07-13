import type { WorkspaceAgentActivityTimelineItem } from "../../../shared/workspaceAgentTimelineTypes";
import {
  extractExitPlanKeepPlanningOptionId,
  extractExitPlanModeOptions,
  isExitPlanSwitchModeInput
} from "../../../shared/agentConversation/exitPlanOptions";
import type {
  AgentGUIApprovalOption,
  AgentGUIApprovalRequest,
  AgentGUIInteractivePrompt,
  AgentGUIInteractiveQuestion,
  AgentGUITimelineRow
} from "./agentGuiConversationTypes";
import { compareTimelineItemsForMerge } from "./agentGuiTimelineMerge";

export function selectPendingApproval(
  rows: readonly AgentGUITimelineRow[]
): AgentGUIApprovalRequest | null {
  return (
    [...rows]
      .filter(
        (row) =>
          row.approval && normalizeStatus(row.status) === "waiting_approval"
      )
      .sort((left, right) => right.occurredAtUnixMs - left.occurredAtUnixMs)[0]
      ?.approval ?? null
  );
}

export function selectPendingApprovalFromTimelineItems(
  timelineItems: readonly WorkspaceAgentActivityTimelineItem[]
): AgentGUIApprovalRequest | null {
  return (
    [...timelineItems]
      .sort((left, right) => compareTimelineItemsForMerge(right, left))
      .map(approvalRequestFromTimelineItem)
      .filter((value): value is AgentGUIApprovalRequest => value !== null)[0] ??
    null
  );
}

export function selectPendingInteractivePromptFromTimelineItems(
  timelineItems: readonly WorkspaceAgentActivityTimelineItem[]
): AgentGUIInteractivePrompt | null {
  return (
    [...timelineItems]
      .sort((left, right) => compareTimelineItemsForMerge(right, left))
      .map(interactivePromptFromTimelineItem)
      .filter(
        (value): value is AgentGUIInteractivePrompt => value !== null
      )[0] ?? null
  );
}

export function approvalRequestFromTimelineItem(
  item: WorkspaceAgentActivityTimelineItem
): AgentGUIApprovalRequest | null {
  const payload = item.payload ?? {};
  const callType =
    normalizeCallType(item.callType) ||
    normalizeCallType(stringPayload(payload.callType));
  if (callType !== "approval") {
    return null;
  }
  if (
    normalizeStatus(item.status) !== "waiting_approval" &&
    normalizeStatus(stringPayload(payload.status)) !== "waiting_approval"
  ) {
    return null;
  }
  const input = objectPayload(payload.input);
  const requestId =
    stringPayload(input?.requestId) || stringPayload(payload.requestId);
  const callId = item.callId?.trim() || stringPayload(payload.callId);
  if (!requestId || !callId) {
    return null;
  }
  const options = normalizeApprovalOptions(
    arrayPayload(input?.options) ?? arrayPayload(payload.options) ?? []
  );
  if (isExitPlanSwitchModeInput(input)) {
    return null;
  }
  return {
    kind: "approval",
    id: String(item.id),
    turnId: item.turnId?.trim() || "turn:unknown",
    requestId,
    callId,
    title:
      item.name?.trim() ||
      stringPayload(payload.name) ||
      item.content?.trim() ||
      callId,
    status: item.status?.trim() || stringPayload(payload.status) || null,
    toolName: item.name?.trim() || stringPayload(payload.name) || null,
    input,
    options,
    output: objectPayload(payload.output),
    occurredAtUnixMs: item.occurredAtUnixMs ?? null
  };
}

export function interactivePromptFromTimelineItem(
  item: WorkspaceAgentActivityTimelineItem
): AgentGUIInteractivePrompt | null {
  const payload = item.payload ?? {};
  const callType =
    normalizeCallType(item.callType) ||
    normalizeCallType(stringPayload(payload.callType));
  const input = objectPayload(payload.input);
  if (callType === "approval") {
    if (!isExitPlanSwitchModeInput(input)) {
      return null;
    }
    const status =
      normalizeStatus(item.status) ||
      normalizeStatus(stringPayload(payload.status));
    if (
      status !== "waiting" &&
      status !== "pending" &&
      status !== "waiting_approval"
    ) {
      return null;
    }
    const requestId =
      stringPayload(input?.requestId) ||
      stringPayload(payload.requestId) ||
      stringPayload(objectPayload(payload.metadata)?.requestId);
    if (!requestId) {
      return null;
    }
    return {
      kind: "exit-plan",
      requestId,
      title:
        stringPayload(objectPayload(input?.toolCall)?.title) ||
        item.name?.trim() ||
        stringPayload(payload.name) ||
        "Exit plan mode",
      options: extractExitPlanModeOptions(input, payload),
      ...(extractExitPlanKeepPlanningOptionId(input, payload)
        ? {
            keepPlanningOptionId: extractExitPlanKeepPlanningOptionId(
              input,
              payload
            ) as string
          }
        : {})
    };
  }
  if (callType !== "interactive") {
    return null;
  }
  const status =
    normalizeStatus(item.status) ||
    normalizeStatus(stringPayload(payload.status));
  if (!isPendingInteractiveStatus(status)) {
    return null;
  }
  const toolName = normalizeInteractiveToolName(
    item.name?.trim() ||
      stringPayload(payload.name) ||
      stringPayload(payload.toolName)
  );
  const requestId =
    stringPayload(input?.requestId) ||
    stringPayload(payload.requestId) ||
    stringPayload(objectPayload(payload.metadata)?.requestId);
  if (!requestId) {
    return null;
  }
  if (toolName === "exitplanmode") {
    return {
      kind: "exit-plan",
      requestId,
      title:
        item.name?.trim() || stringPayload(payload.name) || "Exit plan mode",
      // Legacy exitplanmode tool carries no runtime mode options; the surface
      // falls back to the curated default list.
      options: []
    };
  }
  if (toolName !== "askuserquestion") {
    return null;
  }
  const questions = normalizeInteractiveQuestions(
    arrayPayload(input?.questions) ?? []
  );
  if (questions.length === 0) {
    return null;
  }
  return {
    kind: "ask-user",
    requestId,
    title:
      item.name?.trim() || stringPayload(payload.name) || "Questions for you",
    questions
  };
}

export function timelineRowTime(
  timelineItems: readonly WorkspaceAgentActivityTimelineItem[],
  rowID: string
): number {
  const item = timelineItems.find((candidate) => itemID(candidate) === rowID);
  return item?.occurredAtUnixMs ?? item?.createdAtUnixMs ?? 0;
}

export function timelineRowStatus(
  timelineItems: readonly WorkspaceAgentActivityTimelineItem[],
  rowID: string
): string | null {
  const item = timelineItems.find((candidate) => itemID(candidate) === rowID);
  return itemStatus(item);
}

export function timelineRowTimeByCallId(
  timelineItems: readonly WorkspaceAgentActivityTimelineItem[],
  callID: string
): number {
  const item = [...timelineItems]
    .filter((candidate) => candidate.callId?.trim() === callID)
    .sort(
      (left, right) =>
        (right.occurredAtUnixMs ?? 0) - (left.occurredAtUnixMs ?? 0)
    )[0];
  return item?.occurredAtUnixMs ?? item?.createdAtUnixMs ?? 0;
}

export function timelineRowStatusByCallId(
  timelineItems: readonly WorkspaceAgentActivityTimelineItem[],
  callID: string
): string | null {
  const item = latestTimelineItemByCallId(timelineItems, callID);
  return itemStatus(item);
}

export function latestTimelineItemByCallId(
  timelineItems: readonly WorkspaceAgentActivityTimelineItem[],
  callID: string
): WorkspaceAgentActivityTimelineItem | undefined {
  return [...timelineItems]
    .filter((candidate) => candidate.callId?.trim() === callID)
    .sort(
      (left, right) =>
        (right.occurredAtUnixMs ?? 0) - (left.occurredAtUnixMs ?? 0)
    )[0];
}

export function itemStatus(
  item: WorkspaceAgentActivityTimelineItem | undefined
): string | null {
  if (!item) {
    return null;
  }
  return item.status?.trim() || stringPayload(item.payload?.status) || null;
}

export function itemID(item: WorkspaceAgentActivityTimelineItem): string {
  const eventID = item.eventId?.trim();
  if (eventID) {
    return eventID;
  }
  if (Number.isFinite(item.id) && item.id > 0) {
    return `server:${item.id}`;
  }
  return `local:${item.occurredAtUnixMs ?? 0}:${item.itemType}:${item.role ?? ""}`;
}

export function stableTimelineRowID(
  timelineItems: readonly WorkspaceAgentActivityTimelineItem[],
  detailItemID: string
): string {
  const item = timelineItems.find(
    (candidate) => itemID(candidate) === detailItemID
  );
  const eventID = item?.eventId?.trim();
  return eventID ? `event:${eventID}` : detailItemID;
}

export function normalizeToolCallID(callID: string): string {
  return callID.startsWith("call:") ? callID.slice("call:".length) : callID;
}

export function dedupeTimelineRowsByID(
  rows: AgentGUITimelineRow[]
): AgentGUITimelineRow[] {
  const byID = new Map<string, AgentGUITimelineRow>();
  for (const row of rows) {
    byID.set(row.id, row);
  }
  return sortTimelineRows([...byID.values()]);
}

export function sortTimelineRows(
  rows: AgentGUITimelineRow[]
): AgentGUITimelineRow[] {
  return rows.sort(
    (a, b) =>
      a.occurredAtUnixMs - b.occurredAtUnixMs || a.id.localeCompare(b.id)
  );
}

export function latestTimelineTime(
  timelineItems: readonly WorkspaceAgentActivityTimelineItem[]
): number {
  return Math.max(
    0,
    ...timelineItems.map(
      (item) => item.occurredAtUnixMs ?? item.createdAtUnixMs ?? 0
    )
  );
}

export function normalizeCallType(callType: string | undefined): string {
  return callType?.trim().toLowerCase() ?? "";
}

export function normalizeInteractiveToolName(
  toolName: string | undefined
): string {
  return (toolName?.trim() ?? "").replace(/[_\s-]+/g, "").toLowerCase();
}

export function normalizeStatus(status: string | null | undefined): string {
  const normalized = status?.trim().toLowerCase() ?? "";
  if (normalized === "awaiting_approval") {
    return "waiting_approval";
  }
  if (normalized === "waiting_input") {
    return "waiting";
  }
  return normalized;
}

export function isPendingInteractiveStatus(status: string): boolean {
  return (
    status === "waiting" ||
    status === "pending" ||
    status === "running" ||
    status === "streaming" ||
    status === "working"
  );
}

export function stringPayload(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function objectPayload(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function arrayPayload(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

export function normalizeApprovalOptions(
  values: readonly unknown[]
): AgentGUIApprovalOption[] {
  return values.flatMap((value) => {
    const option = objectPayload(value);
    if (!option) {
      return [];
    }
    const id = stringPayload(option.optionId) || stringPayload(option.id);
    if (!id) {
      return [];
    }
    const label =
      stringPayload(option.name) ||
      stringPayload(option.label) ||
      stringPayload(option.title) ||
      stringPayload(option.kind) ||
      id;
    return [
      {
        id,
        label,
        kind: stringPayload(option.kind) ?? "",
        ...(stringPayload(option.description)
          ? { description: stringPayload(option.description) }
          : {})
      }
    ];
  });
}

export function normalizeInteractiveQuestions(
  values: readonly unknown[]
): AgentGUIInteractiveQuestion[] {
  return values.flatMap((value, index) => {
    const question = objectPayload(value);
    if (!question) {
      return [];
    }
    const id = stringPayload(question.id) || `question-${index + 1}`;
    const options = (arrayPayload(question.options) ?? []).flatMap(
      (optionValue) => {
        const option = objectPayload(optionValue);
        if (!option) {
          return [];
        }
        const label = stringPayload(option.label) || stringPayload(option.name);
        if (!label) {
          return [];
        }
        return [
          {
            label,
            description: stringPayload(option.description)
          }
        ];
      }
    );
    return [
      {
        id,
        header: stringPayload(question.header) || id,
        question:
          stringPayload(question.question) ||
          stringPayload(question.header) ||
          `Question ${index + 1}`,
        options,
        multiSelect: Boolean(question.multiSelect),
        isOther: Boolean(question.isOther)
      }
    ];
  });
}

export function hashStringToPositiveInt(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return Math.max(1, Math.abs(hash));
}
