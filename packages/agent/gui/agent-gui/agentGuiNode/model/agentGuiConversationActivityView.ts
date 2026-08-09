import { resolveAgentGUIConversationSortTimeUnixMs } from "./agentGuiConversationTypes";
import type {
  AgentGUIConversationStatus,
  AgentGUIConversationSummary
} from "./agentGuiConversationTypes";

const ACTIVITY_RECENT_DAY_COUNT = 7;
const EMPTY_DELETED_SESSION_IDS: Readonly<Record<string, true>> = {};

export type AgentGUIConversationActivityPriorityReason =
  | "waiting"
  | "unread"
  | "active";

export interface AgentGUIConversationActivityRootFact {
  needsUserAction: boolean;
  status: AgentGUIConversationStatus;
}

export type AgentGUIConversationActivityCandidate = Pick<
  AgentGUIConversationSummary,
  | "hasUnreadCompletion"
  | "id"
  | "needsUserAction"
  | "sortTimeUnixMs"
  | "status"
  | "updatedAtUnixMs"
>;

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
  priority: readonly AgentGUIConversationActivityMember[];
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
  conversations: readonly AgentGUIConversationActivityCandidate[],
  openedAtUnixMs: number
): AgentGUIConversationActivityActivation {
  const cutoffDate = new Date(localDayStartUnixMs(openedAtUnixMs));
  cutoffDate.setDate(cutoffDate.getDate() - (ACTIVITY_RECENT_DAY_COUNT - 1));
  const cutoffDayStartUnixMs = cutoffDate.getTime();
  const priority: AgentGUIConversationActivityMember[] = [];
  const recent: AgentGUIConversationActivityMember[] = [];
  const seenIds = new Set<string>();
  let admissionOrder = 0;

  for (const conversation of conversations) {
    if (seenIds.has(conversation.id)) continue;
    seenIds.add(conversation.id);
    const admittedAtUnixMs =
      resolveAgentGUIConversationSortTimeUnixMs(conversation);
    const priorityReason = livePriorityReason(conversation);
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
    priority: priority.sort(compareActivityMembers),
    recent: recent.sort(compareActivityMembers)
  };
}

export function reconcileAgentGUIConversationActivityActivation(
  activation: AgentGUIConversationActivityActivation,
  conversations: readonly AgentGUIConversationActivityCandidate[],
  deletedSessionIds: Readonly<Record<string, true>> = EMPTY_DELETED_SESSION_IDS
): AgentGUIConversationActivityActivation {
  // Activity membership is an activation snapshot. Keep the member refs even
  // when a rail refresh temporarily omits their canonical summary; the view
  // layer can render the last known row until the next toggle rebuilds it.
  const retainedPriority = activation.priority.filter(
    (member) => !deletedSessionIds[member.id]
  );
  const retainedRecent = activation.recent.filter(
    (member) => !deletedSessionIds[member.id]
  );
  const priorityIds = new Set(retainedPriority.map((member) => member.id));
  const recentIds = new Set(retainedRecent.map((member) => member.id));
  const currentIds = new Set<string>();
  let admissionOrder = Math.max(
    -1,
    ...activation.priority.map((member) => member.admissionOrder),
    ...activation.recent.map((member) => member.admissionOrder)
  );

  for (const conversation of conversations) {
    if (currentIds.has(conversation.id)) continue;
    if (deletedSessionIds[conversation.id]) continue;
    currentIds.add(conversation.id);
    const currentRecency =
      resolveAgentGUIConversationSortTimeUnixMs(conversation);
    const liveReason = livePriorityReason(conversation);
    if (priorityIds.has(conversation.id)) continue;

    if (recentIds.has(conversation.id) && !liveReason) continue;

    if (recentIds.has(conversation.id)) {
      const recentIndex = retainedRecent.findIndex(
        (member) => member.id === conversation.id
      );
      if (recentIndex >= 0) retainedRecent.splice(recentIndex, 1);
      recentIds.delete(conversation.id);
    }

    // A late canonical snapshot is not an activity signal. It can be a
    // selected historical session or a page that arrived after activation;
    // only live facts may admit a previously unseen session to Priority.
    if (liveReason) {
      retainedPriority.push({
        admissionOrder: ++admissionOrder,
        admittedAtUnixMs: currentRecency,
        id: conversation.id,
        priorityReason: liveReason,
        recentDayStartUnixMs: null
      });
      priorityIds.add(conversation.id);
      continue;
    }
  }

  const nextPriority = retainedPriority.sort(compareActivityMembers);
  const nextRecent = retainedRecent.sort(compareActivityMembers);
  if (
    activityMemberArraysEqual(activation.priority, nextPriority) &&
    activityMemberArraysEqual(activation.recent, nextRecent)
  ) {
    return activation;
  }
  return {
    cutoffDayStartUnixMs: activation.cutoffDayStartUnixMs,
    referenceDayStartUnixMs: activation.referenceDayStartUnixMs,
    priority: nextPriority,
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
  conversation: AgentGUIConversationActivityCandidate
): AgentGUIConversationActivityPriorityReason | null {
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
    default:
      return 3;
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
