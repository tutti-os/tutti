import type { AgentConversationRailSummary } from "@tutti-os/agent-gui/conversation-rail-projection";
import type { WorkspaceConversationRailMembership } from "./workspaceConversationRailService";

export interface WorkspaceConversationRailSection {
  hasMore: boolean;
  id: string;
  items: readonly AgentConversationRailSummary[];
  kind: WorkspaceConversationRailMembership["kind"];
  label: string | null;
  loadingMore: boolean;
  pinnedProject: boolean;
  totalCount: number;
}

export function selectWorkspaceConversationRailSessionIds(
  memberships: readonly Pick<
    WorkspaceConversationRailMembership,
    "sessionIds"
  >[]
): string[] {
  return [
    ...new Set(memberships.flatMap((membership) => membership.sessionIds))
  ];
}

export function projectWorkspaceConversationRail(input: {
  conversations: readonly AgentConversationRailSummary[];
  loadingMoreSectionId: string | null;
  memberships: readonly WorkspaceConversationRailMembership[];
}): WorkspaceConversationRailSection[] {
  const conversationsById = new Map(
    input.conversations.map((conversation) => [conversation.id, conversation])
  );
  const placedIds = new Set<string>();
  const sections = input.memberships.map(
    (membership): WorkspaceConversationRailSection => {
      const items = membership.sessionIds.flatMap((id) => {
        const conversation = conversationsById.get(id);
        if (
          !conversation ||
          !conversationMatchesRailMembership(conversation, membership)
        ) {
          return [];
        }
        placedIds.add(id);
        return [conversation];
      });
      return {
        hasMore: membership.hasMore,
        id: membership.id,
        items: sortRailItems(items, membership.kind),
        kind: membership.kind,
        label: membership.project?.label ?? null,
        loadingMore: membership.id === input.loadingMoreSectionId,
        pinnedProject: (membership.project?.pinnedAtUnixMs ?? 0) > 0,
        totalCount: Math.max(membership.totalCount, items.length)
      };
    }
  );

  for (const conversation of input.conversations) {
    if (placedIds.has(conversation.id)) continue;
    const target = findExactSection(sections, conversation);
    if (target) {
      target.items = sortRailItems(
        [...target.items, conversation],
        target.kind
      );
      target.totalCount = Math.max(target.totalCount, target.items.length);
      continue;
    }
    const pinned = (conversation.pinnedAtUnixMs ?? 0) > 0;
    const sectionKey = conversation.railSectionKey?.trim() ?? "";
    if (!pinned && !sectionKey) continue;
    const kind = pinned
      ? "pinned"
      : sectionKey === "conversations"
        ? "conversations"
        : "project";
    sections.push({
      hasMore: false,
      id: kind === "pinned" ? "pinned" : `section:${sectionKey}`,
      items: [conversation],
      kind,
      label: null,
      loadingMore: false,
      pinnedProject: false,
      totalCount: 1
    });
  }

  return sections
    .filter((section) => section.items.length > 0)
    .sort((left, right) => {
      if (left.kind === "pinned") return right.kind === "pinned" ? 0 : -1;
      if (right.kind === "pinned") return 1;
      return 0;
    });
}

function findExactSection(
  sections: readonly WorkspaceConversationRailSection[],
  conversation: AgentConversationRailSummary
): WorkspaceConversationRailSection | null {
  if (conversation.pinnedAtUnixMs) {
    return sections.find((section) => section.kind === "pinned") ?? null;
  }
  const sectionKey = conversation.railSectionKey?.trim();
  if (!sectionKey) return null;
  return (
    sections.find((section) => section.id === `section:${sectionKey}`) ?? null
  );
}

function conversationMatchesRailMembership(
  conversation: AgentConversationRailSummary,
  membership: WorkspaceConversationRailMembership
): boolean {
  const pinned = (conversation.pinnedAtUnixMs ?? 0) > 0;
  if (membership.kind === "pinned") return pinned;
  if (pinned) return false;
  const railSectionKey = conversation.railSectionKey?.trim() ?? "";
  return (
    railSectionKey !== "" &&
    railSectionKey === (membership.sectionKey?.trim() ?? "")
  );
}

function sortRailItems(
  items: readonly AgentConversationRailSummary[],
  kind: WorkspaceConversationRailMembership["kind"]
): AgentConversationRailSummary[] {
  return [...items].sort(
    (left, right) =>
      (kind === "pinned"
        ? (right.pinnedAtUnixMs ?? 0) - (left.pinnedAtUnixMs ?? 0)
        : 0) ||
      (right.sortTimeUnixMs ?? right.updatedAtUnixMs) -
        (left.sortTimeUnixMs ?? left.updatedAtUnixMs) ||
      left.id.localeCompare(right.id)
  );
}
