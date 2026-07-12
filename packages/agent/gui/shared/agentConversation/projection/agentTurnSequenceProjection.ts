import type { WorkspaceAgentActivityTimelineItem } from "../../workspaceAgentTimelineTypes";
import type {
  WorkspaceAgentSessionDetailMessage,
  WorkspaceAgentSessionDetailThinking,
  WorkspaceAgentSessionDetailTurn
} from "../../workspaceAgentSessionDetailViewModel";
import type {
  AgentMessageContentVM,
  AgentMessageRowVM,
  AgentThinkingContentVM
} from "../contracts/agentMessageRowVM";
import type { AgentToolCallVM } from "../contracts/agentToolCallVM";
import { isApprovalToolCall } from "./agentToolRendererKind";
import { projectAgentToolCall } from "./agentToolProjection";
import {
  isCollaborationTimelineItem,
  projectAgentCollaborationVM
} from "./agentCollaborationProjection";
import { projectConversationUserRow } from "./agentConversationUserProjection";

export type AgentTurnSequenceItemVM =
  | {
      kind: "user-message";
      row: AgentMessageRowVM;
    }
  | {
      kind: "assistant-message";
      message: AgentMessageContentVM;
    }
  | {
      kind: "thinking";
      thinking: AgentThinkingContentVM;
    }
  | {
      kind: "tool-call";
      call: AgentToolCallVM;
    };

export function buildAgentTurnSequenceItems(
  turn: WorkspaceAgentSessionDetailTurn,
  workspaceId?: string | null
): AgentTurnSequenceItemVM[] {
  const items = turn.rawAgentItems ?? turn.agentItems;
  const sequence: AgentTurnSequenceItemVM[] = turn.userMessages.map(
    (message) => ({
      kind: "user-message",
      row: projectConversationUserRow(message, turn.id, workspaceId)
    })
  );
  items.forEach((item) => {
    if (item.kind === "message") {
      sequence.push({
        kind: "assistant-message",
        message: projectMessage(item.message, turn.id)
      });
      return;
    }
    if (item.kind === "thinking") {
      sequence.push({
        kind: "thinking",
        thinking: projectThinking(item.thinking, turn.id)
      });
      return;
    }
    const sourceEntries =
      item.groupEntries ??
      item.toolCalls.map((call) => ({ kind: "tool-call", call }) as const);
    sourceEntries.forEach((entry) => {
      if (entry.kind === "thinking") {
        sequence.push({
          kind: "thinking",
          thinking: projectThinking(entry.thinking, turn.id)
        });
        return;
      }
      if (isApprovalToolCall(entry.call)) {
        return;
      }
      sequence.push({
        kind: "tool-call",
        call: projectAgentToolCall(entry.call)
      });
    });
  });
  return sortTurnSequenceItems(sequence);
}

function sortTurnSequenceItems(
  sequence: readonly AgentTurnSequenceItemVM[]
): AgentTurnSequenceItemVM[] {
  const positioned = sequence.map((item, sourceIndex) => ({
    item,
    sourceIndex,
    position: turnSequencePosition(item)
  }));
  if (positioned.every((entry) => entry.position.seq > 0)) {
    return positioned
      .sort(
        (left, right) =>
          left.position.seq - right.position.seq ||
          left.sourceIndex - right.sourceIndex
      )
      .map((entry) => entry.item);
  }
  if (positioned.every((entry) => entry.position.occurredAtUnixMs > 0)) {
    return positioned
      .sort(
        (left, right) =>
          left.position.occurredAtUnixMs - right.position.occurredAtUnixMs ||
          left.sourceIndex - right.sourceIndex
      )
      .map((entry) => entry.item);
  }
  return [...sequence];
}

function turnSequencePosition(item: AgentTurnSequenceItemVM): {
  seq: number;
  occurredAtUnixMs: number;
} {
  const sourceItems = turnSequenceSourceItems(item);
  const seq = minimumPositive(
    sourceItems.map((sourceItem) => sourceItem.seq ?? 0)
  );
  const occurredAtUnixMs = minimumPositive(
    sourceItems.map(
      (sourceItem) =>
        sourceItem.occurredAtUnixMs ?? sourceItem.createdAtUnixMs ?? 0
    )
  );
  if (occurredAtUnixMs > 0) {
    return { seq, occurredAtUnixMs };
  }
  switch (item.kind) {
    case "user-message":
      return { seq, occurredAtUnixMs: item.row.occurredAtUnixMs ?? 0 };
    case "assistant-message":
      return { seq, occurredAtUnixMs: item.message.occurredAtUnixMs ?? 0 };
    case "thinking":
      return { seq, occurredAtUnixMs: item.thinking.occurredAtUnixMs ?? 0 };
    case "tool-call":
      return { seq, occurredAtUnixMs: item.call.occurredAtUnixMs ?? 0 };
  }
}

function turnSequenceSourceItems(
  item: AgentTurnSequenceItemVM
): WorkspaceAgentActivityTimelineItem[] {
  switch (item.kind) {
    case "user-message":
      return item.row.messages.flatMap(
        (message) => message.sourceTimelineItems ?? []
      );
    case "assistant-message":
      return item.message.sourceTimelineItems ?? [];
    case "thinking":
      return item.thinking.sourceTimelineItems ?? [];
    case "tool-call":
      return item.call.sourceTimelineItems ?? [];
  }
}

function minimumPositive(values: readonly number[]): number {
  return values.reduce(
    (minimum, value) =>
      value > 0 && (minimum === 0 || value < minimum) ? value : minimum,
    0
  );
}

function projectMessage(
  message: WorkspaceAgentSessionDetailMessage,
  turnId: string
): AgentMessageContentVM {
  const projected: AgentMessageContentVM = {
    kind: "message-content",
    id: message.id,
    turnId: message.turnId ?? turnId,
    body: message.body,
    statusKind: message.statusKind ?? null,
    occurredAtUnixMs: message.occurredAtUnixMs ?? null,
    visibleError: message.visibleError ?? null,
    systemNotice: message.systemNotice ?? null
  };
  if (message.sourceTimelineItems) {
    projected.sourceTimelineItems = message.sourceTimelineItems;
    if (
      message.sourceTimelineItems.some(
        (item) => item.payload?.messageKind === "plan"
      )
    ) {
      projected.contentKind = "plan";
    }
    const collaborationItem = message.sourceTimelineItems.find(
      isCollaborationTimelineItem
    );
    if (collaborationItem) {
      const collaboration = projectAgentCollaborationVM(collaborationItem);
      if (collaboration) {
        projected.contentKind = "collaboration";
        projected.collaboration = collaboration;
      }
    }
  }
  return projected;
}

function projectThinking(
  thinking: WorkspaceAgentSessionDetailThinking,
  turnId: string
): AgentThinkingContentVM {
  const projected: AgentThinkingContentVM = {
    kind: "thinking-content",
    id: thinking.id,
    turnId: thinking.turnId ?? turnId,
    body: thinking.body,
    statusKind: thinking.statusKind ?? null,
    occurredAtUnixMs: thinking.occurredAtUnixMs ?? null
  };
  if (thinking.sourceTimelineItems) {
    projected.sourceTimelineItems = thinking.sourceTimelineItems;
  }
  return projected;
}
