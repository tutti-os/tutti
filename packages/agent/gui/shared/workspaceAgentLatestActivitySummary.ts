import type { WorkspaceAgentActivityTimelineItem } from "./workspaceAgentActivityTypes";
import { translate, translateInUiLanguage } from "../i18n/index";
import { isWorkspaceAgentSyntheticControlMessage } from "./workspaceAgentSyntheticMessages";

export type WorkspaceAgentLatestActivityStatus =
  | "working"
  | "waiting"
  | "idle"
  | "completed"
  | "canceled"
  | "failed";

export interface WorkspaceAgentLatestActivityActors {
  agentName: string;
  userName: string;
}

export interface WorkspaceAgentLatestActivitySummary {
  actorName: string;
  summary: string;
}

export interface WorkspaceAgentConversationPreviewLine {
  actorName: string;
  summary: string;
}

export function activityTitleFromTimeline(
  timelineItems: WorkspaceAgentActivityTimelineItem[],
  fallbackTitle = ""
): string {
  return (
    compactText(fallbackTitle) ||
    latestUserMessageText(timelineItems) ||
    workspaceAgentUntitledTaskLabel()
  );
}

export function resolveLatestActivitySummary(
  timelineItems: WorkspaceAgentActivityTimelineItem[],
  status: WorkspaceAgentLatestActivityStatus,
  actors: WorkspaceAgentLatestActivityActors
): WorkspaceAgentLatestActivitySummary {
  for (const item of [...timelineItems].sort(compareTimelineItemsDescending)) {
    const summary = displayableActivitySummary(item);
    if (summary) {
      return {
        actorName: activityActorName(item, actors),
        summary
      };
    }
  }
  return {
    actorName: actors.agentName,
    summary: fallbackSummary(status)
  };
}

export function fallbackSummary(
  status: WorkspaceAgentLatestActivityStatus
): string {
  switch (status) {
    case "working":
      return translate("agentHost.workspaceAgentActivityStatusWorking");
    case "waiting":
      return translate("agentHost.workspaceAgentActivityStatusWaiting");
    case "idle":
      return translate("agentHost.workspaceAgentActivityStatusIdle");
    case "canceled":
    case "completed":
      return translate("agentHost.workspaceAgentActivityStatusEnd");
    case "failed":
      return translate("agentHost.workspaceAgentActivityStatusFailed");
  }
}

export function isWorkspaceAgentIdleSummary(summary: string): boolean {
  return localizedWorkspaceAgentLabelSet(
    "agentHost.workspaceAgentActivityStatusIdle"
  ).has(compactText(summary));
}

export function isWorkspaceAgentUntitledTask(title: string): boolean {
  return localizedWorkspaceAgentLabelSet(
    "agentHost.workspaceAgentsUntitledTask"
  ).has(compactText(title));
}

export function latestUserMessageFromTimeline(
  timelineItems: WorkspaceAgentActivityTimelineItem[]
): string {
  return latestUserMessageText(timelineItems);
}

export function latestAgentMessageFromTimeline(
  timelineItems: WorkspaceAgentActivityTimelineItem[]
): string {
  return latestAgentMessageText(timelineItems);
}

export function buildUserAndAgentConversationPreview(input: {
  timelineItems: WorkspaceAgentActivityTimelineItem[];
  userName: string;
  agentName: string;
  userPromptFallback?: string;
  status: WorkspaceAgentLatestActivityStatus;
}): WorkspaceAgentConversationPreviewLine[] {
  const timeline = input.timelineItems ?? [];
  const lines: WorkspaceAgentConversationPreviewLine[] = [];
  const userMessage =
    compactText(input.userPromptFallback ?? "") ||
    latestUserMessageFromTimeline(timeline);

  if (userMessage) {
    lines.push({ actorName: input.userName, summary: userMessage });
  }

  const agentMessage = latestAgentMessageFromTimeline(timeline);
  if (agentMessage) {
    lines.push({ actorName: input.agentName, summary: agentMessage });
  } else if (userMessage || timeline.length > 0) {
    const latestActivity = resolveLatestActivitySummary(
      timeline,
      input.status,
      {
        userName: input.userName,
        agentName: input.agentName
      }
    );
    if (
      latestActivity.actorName === input.agentName &&
      latestActivity.summary
    ) {
      lines.push({
        actorName: input.agentName,
        summary: latestActivity.summary
      });
    } else {
      lines.push({
        actorName: input.agentName,
        summary: fallbackSummary(input.status)
      });
    }
  }

  return lines;
}

function latestUserMessageText(
  timelineItems: WorkspaceAgentActivityTimelineItem[]
): string {
  const latestUserMessage = [...timelineItems]
    .filter(isUserMessageItem)
    .sort(compareTimelineItemsDescending)[0];
  if (!latestUserMessage) {
    return "";
  }

  return firstPresentText(
    stringPayloadValue(latestUserMessage, "displayPrompt"),
    stringPayloadValue(latestUserMessage, "text"),
    stringPayloadValue(latestUserMessage, "content"),
    latestUserMessage.content
  );
}

function displayableActivitySummary(
  item: WorkspaceAgentActivityTimelineItem
): string {
  if (messageRole(item)) {
    return messageContent(item);
  }

  return "";
}

function activityActorName(
  item: WorkspaceAgentActivityTimelineItem,
  actors: WorkspaceAgentLatestActivityActors
): string {
  return messageRole(item) === "user" ? actors.userName : actors.agentName;
}

function isUserMessageItem(item: WorkspaceAgentActivityTimelineItem): boolean {
  return (
    isMessageItem(item) &&
    messageRole(item) === "user" &&
    messageContent(item).length > 0
  );
}

function latestAgentMessageText(
  timelineItems: WorkspaceAgentActivityTimelineItem[]
): string {
  const latestAgentMessage = [...timelineItems]
    .filter(isAgentMessageItem)
    .sort(compareTimelineItemsDescending)[0];
  if (!latestAgentMessage) {
    return "";
  }

  return messageContent(latestAgentMessage);
}

function isAgentMessageItem(item: WorkspaceAgentActivityTimelineItem): boolean {
  return (
    isMessageItem(item) &&
    messageRole(item) === "agent" &&
    messageContent(item).length > 0
  );
}

function isMessageItem(item: WorkspaceAgentActivityTimelineItem): boolean {
  return item.itemType === "message" || item.itemType.startsWith("message.");
}

function messageRole(
  item: WorkspaceAgentActivityTimelineItem
): "user" | "agent" | null {
  const explicitRole = item.role?.trim().toLowerCase();
  if (explicitRole === "user") {
    return "user";
  }
  if (explicitRole === "assistant" || explicitRole === "agent") {
    return "agent";
  }

  const itemType = item.itemType.trim().toLowerCase();
  if (itemType === "message.user") {
    return "user";
  }
  if (itemType === "message.agent" || itemType === "message.assistant") {
    return "agent";
  }
  return null;
}

function messageContent(item: WorkspaceAgentActivityTimelineItem): string {
  const content = firstPresentText(
    stringPayloadValue(item, "displayPrompt"),
    stringPayloadValue(item, "text"),
    stringPayloadValue(item, "content"),
    item.content
  );
  return isWorkspaceAgentSyntheticControlMessage(content) ? "" : content;
}

function stringPayloadValue(
  item: WorkspaceAgentActivityTimelineItem,
  key: "content" | "displayPrompt" | "summary" | "text"
): string {
  const value = item.payload?.[key];
  return typeof value === "string" ? value : "";
}

function compareTimelineItemsDescending(
  left: WorkspaceAgentActivityTimelineItem,
  right: WorkspaceAgentActivityTimelineItem
): number {
  const leftTime = timelineTime(left);
  const rightTime = timelineTime(right);
  const timeDiff = (rightTime ?? 0) - (leftTime ?? 0);
  if (timeDiff !== 0) {
    return timeDiff;
  }
  return right.id - left.id || right.eventId.localeCompare(left.eventId);
}

function timelineTime(
  item: WorkspaceAgentActivityTimelineItem | null | undefined
): number | null {
  if (!item) {
    return null;
  }
  return item.occurredAtUnixMs ?? item.createdAtUnixMs ?? null;
}

function firstPresentText(...values: Array<string | undefined>): string {
  for (const value of values) {
    const text = compactText(value ?? "");
    if (text) {
      return text;
    }
  }
  return "";
}

function compactText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function workspaceAgentUntitledTaskLabel(): string {
  return translate("agentHost.workspaceAgentsUntitledTask");
}

function localizedWorkspaceAgentLabelSet(key: string): Set<string> {
  return new Set(
    (["en", "zh-CN"] as const)
      .map((language) => compactText(translateInUiLanguage(language, key)))
      .filter(Boolean)
  );
}
