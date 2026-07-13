import type { AgentSessionEvent } from "../../agentSessionTypes";
import type { AgentConversationVM } from "../contracts/agentConversationVM";
import type { BuildWorkspaceAgentSessionDetailInput } from "../../workspaceAgentSessionDetailViewModel";
import { projectWorkspaceAgentTimelineToConversationVM } from "./workspaceAgentTimelineProjection";
import type { WorkspaceAgentActivityTimelineItem } from "../../workspaceAgentTimelineTypes";

export function projectAgentSessionEventsToTimelineItems(
  events: readonly AgentSessionEvent[]
): WorkspaceAgentActivityTimelineItem[] {
  return mergeSessionEvents(events).map((event, index) =>
    sessionEventToTimelineItem(event, index + 1)
  );
}

export function projectAgentSessionEventsToConversationVM(
  input: Omit<BuildWorkspaceAgentSessionDetailInput, "timelineItems"> & {
    events: readonly AgentSessionEvent[];
  }
): AgentConversationVM {
  return projectWorkspaceAgentTimelineToConversationVM({
    ...input,
    timelineItems: projectAgentSessionEventsToTimelineItems(input.events)
  });
}

function mergeSessionEvents(
  events: readonly AgentSessionEvent[]
): AgentSessionEvent[] {
  const byKey = new Map<string, AgentSessionEvent>();
  for (const event of [...events].sort(compareSessionEvents)) {
    byKey.set(sessionEventMergeKey(event), event);
  }
  return [...byKey.values()].sort(compareSessionEvents);
}

function sessionEventMergeKey(event: AgentSessionEvent): string {
  const callId = stringPayload(event.payload?.callId);
  if (callId) {
    return `call:${event.turnId?.trim() ?? ""}:${callId}`;
  }
  if (event.type === "message") {
    return `message:${event.id}`;
  }
  return `event:${event.id}`;
}

function sessionEventToTimelineItem(
  event: AgentSessionEvent,
  seq: number
): WorkspaceAgentActivityTimelineItem {
  const callId = stringPayload(event.payload?.callId);
  const callType = stringPayload(event.payload?.callType);
  const name = stringPayload(event.payload?.name);
  const workspaceId = workspaceIdFromSessionEvent(event);
  return {
    id: hashStringToPositiveInt(event.id),
    ...workspaceTimelineFields(workspaceId),
    agentSessionId: event.agentSessionId,
    turnId: event.turnId,
    seq,
    eventId: event.id,
    actorType: event.role === "user" ? "user" : "agent",
    actorId: event.provider,
    itemType: timelineItemTypeFromSessionEvent(event),
    role: event.role,
    callId: callId || undefined,
    callType: callType || undefined,
    name: name || undefined,
    status: event.status,
    content: event.content,
    payload: {
      ...event.payload,
      content: event.content ?? event.payload?.content,
      text: event.payload?.text
    },
    occurredAtUnixMs: event.occurredAtUnixMs,
    createdAtUnixMs: event.occurredAtUnixMs
  };
}

function workspaceIdFromSessionEvent(event: AgentSessionEvent): string {
  return event.workspaceId.trim();
}

function workspaceTimelineFields(
  workspaceId: string
): Pick<WorkspaceAgentActivityTimelineItem, "workspaceId"> {
  return {
    workspaceId
  };
}

function timelineItemTypeFromSessionEvent(event: AgentSessionEvent): string {
  if (event.type === "message") {
    return event.role === "user" ? "message.user" : "message.assistant";
  }
  if (
    event.type === "call.started" ||
    event.type === "call.completed" ||
    event.type === "call.failed"
  ) {
    return "call";
  }
  return "event";
}

function compareSessionEvents(
  left: AgentSessionEvent,
  right: AgentSessionEvent
): number {
  return (
    (left.occurredAtUnixMs ?? 0) - (right.occurredAtUnixMs ?? 0) ||
    left.id.localeCompare(right.id)
  );
}

function hashStringToPositiveInt(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash) || 1;
}

function stringPayload(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
