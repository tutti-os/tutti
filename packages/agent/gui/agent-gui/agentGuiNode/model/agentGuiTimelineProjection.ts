import type { AgentActivityMessage } from "@tutti-os/agent-activity-core";
import { buildWorkspaceAgentActivityListViewModel } from "../../../shared/workspaceAgentActivityListViewModel";
import {
  buildWorkspaceAgentSessionDetailViewModel,
  type WorkspaceAgentSessionDetailToolCall
} from "../../../shared/workspaceAgentSessionDetailViewModel";
import {
  firstAgentGUIUserMessageTitle,
  resolveAgentGUIProviderIdentity
} from "../../../shared/agentConversationTitleProjection.ts";
import { type WorkspaceAgentActivityTimelineItem } from "../../../shared/workspaceAgentTimelineTypes";
import {
  normalizeAgentActivitySession,
  type AgentActivitySession
} from "@tutti-os/agent-activity-core";
import {
  type AgentGUIConversationProjectionSource,
  type AgentGUITimelineRow
} from "./agentGuiConversationTypes";
import {
  approvalRequestFromTimelineItem,
  dedupeTimelineRowsByID,
  latestTimelineItemByCallId,
  latestTimelineTime,
  normalizeToolCallID,
  stableTimelineRowID,
  timelineRowStatus,
  timelineRowStatusByCallId,
  timelineRowTime,
  timelineRowTimeByCallId
} from "./agentGuiInteractiveProjection";

export function timelineRowsFromActivityTimelineItems(
  timelineItems: WorkspaceAgentActivityTimelineItem[]
): AgentGUITimelineRow[] {
  if (timelineItems.length === 0) {
    return [];
  }
  const session = timelineSessionFromItems(timelineItems);
  const activity =
    buildWorkspaceAgentActivityListViewModel(
      {
        presences: [],
        sessions: [session]
      },
      {
        sessionMessagesById: {
          [session.agentSessionId]:
            workspaceAgentMessagesFromTimelineItems(timelineItems)
        }
      }
    ).activities[0] ?? null;
  if (!activity) {
    return [];
  }
  const detail = buildWorkspaceAgentSessionDetailViewModel({
    activity,
    session,
    timelineItems
  });
  const rows: AgentGUITimelineRow[] = [];
  for (const turn of detail.turns) {
    for (const message of turn.userMessages) {
      const rowID = stableTimelineRowID(timelineItems, message.id);
      rows.push({
        id: rowID,
        turnId: turn.id,
        role: "user",
        content: message.body,
        eventType: "message.user",
        status: timelineRowStatus(timelineItems, message.id),
        occurredAtUnixMs: timelineRowTime(timelineItems, message.id)
      });
    }
    for (const item of turn.agentItems) {
      if (item.kind === "message") {
        const rowID = stableTimelineRowID(timelineItems, item.message.id);
        rows.push({
          id: rowID,
          turnId: turn.id,
          role: "assistant",
          content: item.message.body,
          eventType: "message.assistant",
          status: timelineRowStatus(timelineItems, item.message.id),
          occurredAtUnixMs: timelineRowTime(timelineItems, item.message.id)
        });
      } else if (item.kind === "thinking") {
        const rowID = stableTimelineRowID(timelineItems, item.thinking.id);
        rows.push({
          id: rowID,
          turnId: turn.id,
          role: "assistant_thinking",
          content: item.thinking.body,
          eventType: "message.assistant_thinking",
          status: timelineRowStatus(timelineItems, item.thinking.id),
          occurredAtUnixMs: timelineRowTime(timelineItems, item.thinking.id)
        });
      } else {
        for (const call of item.toolCalls) {
          const callID = normalizeToolCallID(call.id);
          const latestCallItem = latestTimelineItemByCallId(
            timelineItems,
            callID
          );
          const approval = latestCallItem
            ? approvalRequestFromTimelineItem(latestCallItem)
            : null;
          rows.push({
            id: `call:${turn.id}:${callID}`,
            turnId: turn.id,
            role: "tool",
            content: toolRowContent(call, approval?.title || null),
            eventType: "call",
            status:
              timelineRowStatusByCallId(timelineItems, callID) ?? call.status,
            callType: latestCallItem?.callType?.trim() || undefined,
            approval,
            occurredAtUnixMs: timelineRowTimeByCallId(timelineItems, callID)
          });
        }
      }
    }
  }
  return dedupeTimelineRowsByID(rows);
}

export function toolRowContent(
  call: WorkspaceAgentSessionDetailToolCall,
  approvalTitle: string | null
): string {
  if (approvalTitle?.trim()) {
    return approvalTitle.trim();
  }
  const summary = call.summary.trim();
  if (summary && !looksLikeOpaqueFunctionCallSummary(summary)) {
    return summary;
  }
  return call.name;
}

export function looksLikeOpaqueFunctionCallSummary(value: string): boolean {
  return /^call function [a-z0-9]+(?: \d+)?$/i.test(value.trim());
}

export function timelineSessionFromItems(
  timelineItems: readonly WorkspaceAgentActivityTimelineItem[],
  conversation?: AgentGUIConversationProjectionSource
): AgentActivitySession {
  const first = timelineItems[0];
  const fallbackAgentSessionId =
    first?.agentSessionId?.trim() ||
    conversation?.id?.trim() ||
    "agent-gui-session";
  const provider = resolveAgentGUIProviderIdentity({
    conversationProvider: conversation?.provider,
    timelineItems
  });
  const workspaceId = first?.workspaceId?.trim() || "";
  return normalizeAgentActivitySession({
    workspaceId,
    agentSessionId: fallbackAgentSessionId,
    userId: conversation?.userId?.trim() ?? "",
    provider: provider ?? "",
    providerSessionId: fallbackAgentSessionId,
    cwd: conversation?.cwd?.trim() ?? "",
    activeTurn: conversation?.activeTurn ?? null,
    activeTurnId: conversation?.activeTurn?.turnId ?? null,
    title: conversation?.title ?? "",
    createdAtUnixMs: first?.createdAtUnixMs ?? first?.occurredAtUnixMs ?? 0,
    updatedAtUnixMs:
      latestTimelineTime(timelineItems) || conversation?.updatedAtUnixMs || 0,
    pinnedAtUnixMs: conversation?.pinnedAtUnixMs ?? null
  });
}

export function firstUserMessageTitleFromTimelineItems(
  timelineItems: readonly WorkspaceAgentActivityTimelineItem[]
): string {
  const userMessage = [...timelineItems]
    .filter(
      (item) =>
        timelineItemRole(item) === "user" && timelineItemText(item).length > 0
    )
    .sort(compareTimelineItemsAscending)[0];
  return userMessage ? timelineItemText(userMessage) : "";
}

export function firstUserMessageTitleFromMessages(
  messages: readonly AgentActivityMessage[]
): string {
  return firstAgentGUIUserMessageTitle(messages);
}

export function workspaceAgentMessagesFromTimelineItems(
  timelineItems: readonly WorkspaceAgentActivityTimelineItem[]
): AgentActivityMessage[] {
  return timelineItems.map((item, index) => {
    const messageId =
      item.eventId || `${item.agentSessionId}:${item.id}:${index}`;
    const version = item.seq ?? item.id;
    return {
      id: item.id,
      workspaceId: item.workspaceId,
      agentSessionId: item.agentSessionId,
      messageId,
      version,
      turnId: item.turnId || `timeline:${messageId}`,
      role: item.role ?? timelineItemRole(item) ?? item.actorType,
      kind: item.itemType === "call" ? "tool_call" : item.itemType,
      ...(item.status ? { status: item.status } : {}),
      payload: {
        ...item.payload,
        content: item.payload?.content ?? item.content,
        text: item.payload?.text ?? item.content,
        callType: item.callType,
        callId: item.callId,
        name: item.name
      },
      occurredAtUnixMs:
        item.occurredAtUnixMs ?? item.createdAtUnixMs ?? version,
      startedAtUnixMs: item.createdAtUnixMs,
      completedAtUnixMs: item.occurredAtUnixMs
    };
  });
}

export function timelineItemRole(
  item: WorkspaceAgentActivityTimelineItem
): "user" | "agent" | null {
  const role = item.role?.trim().toLowerCase();
  if (role === "user") {
    return "user";
  }
  if (role === "assistant" || role === "agent") {
    return "agent";
  }
  const itemType = item.itemType.trim().toLowerCase();
  if (itemType === "message.user") {
    return "user";
  }
  if (itemType === "message.assistant" || itemType === "message.agent") {
    return "agent";
  }
  return null;
}

export function timelineItemText(
  item: WorkspaceAgentActivityTimelineItem
): string {
  const payloadDisplayPrompt =
    typeof item.payload?.displayPrompt === "string"
      ? item.payload.displayPrompt
      : "";
  const payloadContent =
    typeof item.payload?.content === "string" ? item.payload.content : "";
  const payloadText =
    typeof item.payload?.text === "string" ? item.payload.text : "";
  return (payloadDisplayPrompt || payloadText || item.content || payloadContent)
    .replace(/\s+/g, " ")
    .trim();
}

export function compareTimelineItemsAscending(
  left: WorkspaceAgentActivityTimelineItem,
  right: WorkspaceAgentActivityTimelineItem
): number {
  const leftTime = left.occurredAtUnixMs ?? left.createdAtUnixMs ?? 0;
  const rightTime = right.occurredAtUnixMs ?? right.createdAtUnixMs ?? 0;
  const timeDiff = leftTime - rightTime;
  if (timeDiff !== 0) {
    return timeDiff;
  }
  return left.id - right.id || left.eventId.localeCompare(right.eventId);
}

export function sessionLifecycleStatus(status: string): string {
  switch (status.trim().toLowerCase()) {
    case "completed":
    case "canceled":
      return "ended";
    case "failed":
      return "failed";
    default:
      return "active";
  }
}
