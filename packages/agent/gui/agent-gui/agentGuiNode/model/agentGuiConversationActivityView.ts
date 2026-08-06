import { resolveAgentGUIConversationSortTimeUnixMs } from "./agentGuiConversationTypes";
import type { AgentGUIConversationSummary } from "./agentGuiConversationTypes";

const ACTIVITY_RECENT_DAY_COUNT = 7;

export type AgentGUIConversationActivityPriorityReason =
  | "waiting"
  | "unread"
  | "active"
  | "retained-idle";

export interface AgentGUIConversationActivityMember {
  id: string;
  admissionOrder: number;
  admittedAtUnixMs: number;
  priorityReason: AgentGUIConversationActivityPriorityReason | null;
  recentDayStartUnixMs: number | null;
}

export interface AgentGUIConversationActivityActivation {
  cutoffDayStartUnixMs: number;
  referenceDayStartUnixMs: number;
  observedIds: readonly string[];
  priority: readonly AgentGUIConversationActivityMember[];
  priorityRetentionRecencyById: ReadonlyMap<string, number>;
  recent: readonly AgentGUIConversationActivityMember[];
}

export interface AgentGUIConversationActivityDateSection {
  dayStartUnixMs: number;
  ids: readonly string[];
}

export interface AgentGUIConversationActivityProjection {
  priorityIds: readonly string[];
  priorityReasonsById: ReadonlyMap<
    string,
    AgentGUIConversationActivityPriorityReason
  >;
  recentSections: readonly AgentGUIConversationActivityDateSection[];
  referenceDayStartUnixMs: number;
}

export function createAgentGUIConversationActivityActivation(
  conversations: readonly AgentGUIConversationSummary[],
  openedAtUnixMs: number,
  priorityRetentionRecencyById: ReadonlyMap<string, number> = new Map()
): AgentGUIConversationActivityActivation {
  const cutoffDate = new Date(localDayStartUnixMs(openedAtUnixMs));
  cutoffDate.setDate(cutoffDate.getDate() - (ACTIVITY_RECENT_DAY_COUNT - 1));
  const cutoffDayStartUnixMs = cutoffDate.getTime();
  const priority: AgentGUIConversationActivityMember[] = [];
  const recent: AgentGUIConversationActivityMember[] = [];
  const retainedRecency = new Map<string, number>();
  const observedIds = new Set<string>();
  let admissionOrder = 0;

  for (const conversation of conversations) {
    if (observedIds.has(conversation.id)) continue;
    observedIds.add(conversation.id);
    const admittedAtUnixMs =
      resolveAgentGUIConversationSortTimeUnixMs(conversation);
    const retainedIdle =
      priorityRetentionRecencyById.get(conversation.id) === admittedAtUnixMs;
    if (retainedIdle) retainedRecency.set(conversation.id, admittedAtUnixMs);
    const priorityReason =
      livePriorityReason(conversation) ??
      (retainedIdle ? "retained-idle" : null);
    if (priorityReason) {
      priority.push({
        admissionOrder: admissionOrder++,
        admittedAtUnixMs,
        id: conversation.id,
        priorityReason,
        recentDayStartUnixMs: null
      });
      continue;
    }
    const recentDayStartUnixMs = localDayStartUnixMs(admittedAtUnixMs);
    if (recentDayStartUnixMs >= cutoffDayStartUnixMs) {
      recent.push({
        admissionOrder: admissionOrder++,
        admittedAtUnixMs,
        id: conversation.id,
        priorityReason: null,
        recentDayStartUnixMs
      });
    }
  }

  return {
    cutoffDayStartUnixMs,
    referenceDayStartUnixMs: localDayStartUnixMs(openedAtUnixMs),
    observedIds: [...observedIds].sort(),
    priority: priority.sort(compareActivityMembers),
    priorityRetentionRecencyById: retainedRecency,
    recent: recent.sort(compareActivityMembers)
  };
}

export function reconcileAgentGUIConversationActivityActivation(
  activation: AgentGUIConversationActivityActivation,
  conversations: readonly AgentGUIConversationSummary[]
): AgentGUIConversationActivityActivation {
  const conversationsById = new Map(
    conversations.map((conversation) => [conversation.id, conversation])
  );
  const retainedPriority = activation.priority.filter((member) =>
    conversationsById.has(member.id)
  );
  const retainedRecent = activation.recent.filter((member) =>
    conversationsById.has(member.id)
  );
  const priorityIds = new Set(retainedPriority.map((member) => member.id));
  const retainedPriorityById = new Map(
    retainedPriority.map((member) => [member.id, member])
  );
  const recentIds = new Set(retainedRecent.map((member) => member.id));
  const previouslyObservedIds = new Set(activation.observedIds);
  const observedIds = new Set<string>();
  const priorityRetentionRecencyById = new Map<string, number>();
  let admissionOrder = Math.max(
    -1,
    ...activation.priority.map((member) => member.admissionOrder),
    ...activation.recent.map((member) => member.admissionOrder)
  );

  for (const conversation of conversations) {
    if (observedIds.has(conversation.id)) continue;
    observedIds.add(conversation.id);
    const currentRecency =
      resolveAgentGUIConversationSortTimeUnixMs(conversation);
    const liveReason = livePriorityReason(conversation);
    const retainedPriorityMember = retainedPriorityById.get(conversation.id);
    const previousRetentionRecency =
      activation.priorityRetentionRecencyById.get(conversation.id);
    if (previousRetentionRecency === currentRecency) {
      priorityRetentionRecencyById.set(conversation.id, currentRecency);
    } else if (
      previousRetentionRecency === undefined &&
      !liveReason &&
      retainedPriorityMember?.priorityReason === "unread"
    ) {
      priorityRetentionRecencyById.set(conversation.id, currentRecency);
    }
    if (priorityIds.has(conversation.id)) continue;

    const wasObserved = previouslyObservedIds.has(conversation.id);
    if (recentIds.has(conversation.id) && !liveReason) continue;

    if (recentIds.has(conversation.id)) {
      const recentIndex = retainedRecent.findIndex(
        (member) => member.id === conversation.id
      );
      if (recentIndex >= 0) retainedRecent.splice(recentIndex, 1);
      recentIds.delete(conversation.id);
    }

    if (liveReason || !wasObserved) {
      if (!liveReason) {
        priorityRetentionRecencyById.set(conversation.id, currentRecency);
      }
      retainedPriority.push({
        admissionOrder: ++admissionOrder,
        admittedAtUnixMs: currentRecency,
        id: conversation.id,
        priorityReason: liveReason ?? "retained-idle",
        recentDayStartUnixMs: null
      });
      priorityIds.add(conversation.id);
    }
  }

  const nextObservedIds = [...observedIds].sort();
  const nextPriority = retainedPriority.sort(compareActivityMembers);
  const nextRecent = retainedRecent.sort(compareActivityMembers);
  if (
    stringArraysEqual(activation.observedIds, nextObservedIds) &&
    activityMemberArraysEqual(activation.priority, nextPriority) &&
    activityMemberArraysEqual(activation.recent, nextRecent) &&
    numberMapsEqual(
      activation.priorityRetentionRecencyById,
      priorityRetentionRecencyById
    )
  ) {
    return activation;
  }
  return {
    cutoffDayStartUnixMs: activation.cutoffDayStartUnixMs,
    referenceDayStartUnixMs: activation.referenceDayStartUnixMs,
    observedIds: nextObservedIds,
    priority: nextPriority,
    priorityRetentionRecencyById,
    recent: nextRecent
  };
}

export function projectAgentGUIConversationActivity(
  activation: AgentGUIConversationActivityActivation
): AgentGUIConversationActivityProjection {
  const recentSections: AgentGUIConversationActivityDateSection[] = [];
  for (const member of activation.recent) {
    const dayStartUnixMs = member.recentDayStartUnixMs;
    if (dayStartUnixMs === null) continue;
    const currentSection = recentSections.at(-1);
    if (currentSection?.dayStartUnixMs === dayStartUnixMs) {
      currentSection.ids = [...currentSection.ids, member.id];
    } else {
      recentSections.push({ dayStartUnixMs, ids: [member.id] });
    }
  }
  return {
    priorityIds: activation.priority.map((member) => member.id),
    priorityReasonsById: new Map(
      activation.priority.flatMap((member) =>
        member.priorityReason ? [[member.id, member.priorityReason]] : []
      )
    ),
    recentSections,
    referenceDayStartUnixMs: activation.referenceDayStartUnixMs
  };
}

export function localDayStartUnixMs(value: number): number {
  const date = new Date(value);
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate()
  ).getTime();
}

function livePriorityReason(
  conversation: AgentGUIConversationSummary
): Exclude<AgentGUIConversationActivityPriorityReason, "retained-idle"> | null {
  if (conversation.needsUserAction || conversation.status === "waiting") {
    return "waiting";
  }
  if (conversation.hasUnreadCompletion) return "unread";
  if (conversation.status === "working") return "active";
  return null;
}

function compareActivityMembers(
  left: AgentGUIConversationActivityMember,
  right: AgentGUIConversationActivityMember
): number {
  const priorityDifference =
    priorityRank(left.priorityReason) - priorityRank(right.priorityReason);
  if (priorityDifference !== 0) return priorityDifference;
  return (
    right.admittedAtUnixMs - left.admittedAtUnixMs ||
    left.admissionOrder - right.admissionOrder ||
    left.id.localeCompare(right.id)
  );
}

function priorityRank(
  reason: AgentGUIConversationActivityPriorityReason | null
): number {
  switch (reason) {
    case "waiting":
      return 0;
    case "unread":
      return 1;
    case "active":
      return 2;
    case "retained-idle":
      return 3;
    default:
      return 4;
  }
}

function activityMemberArraysEqual(
  left: readonly AgentGUIConversationActivityMember[],
  right: readonly AgentGUIConversationActivityMember[]
): boolean {
  return (
    left.length === right.length &&
    left.every((member, index) => member === right[index])
  );
}

function stringArraysEqual(
  left: readonly string[],
  right: readonly string[]
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function numberMapsEqual(
  left: ReadonlyMap<string, number>,
  right: ReadonlyMap<string, number>
): boolean {
  return (
    left.size === right.size &&
    [...left].every(([key, value]) => right.get(key) === value)
  );
}
