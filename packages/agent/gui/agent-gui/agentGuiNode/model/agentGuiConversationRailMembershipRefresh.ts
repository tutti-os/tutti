import type { ConversationRailSectionMembership } from "./agentGuiConversationRail";

export interface ConversationRailMembershipRecord {
  agentTargetId?: string | null;
  id: string;
  pinnedAtUnixMs?: number | null;
  projectionSource?: "pending_activation";
  railSectionKey?: string | null;
  title: string;
}

export type ConversationRailMembershipRefreshPlan =
  | { kind: "none" }
  | {
      kind: "refresh_pages";
      pageIds: readonly string[];
      reconcilingSessionIds: readonly string[];
      refreshSearch: boolean;
    };

export function planRuntimeRailMembershipRefresh(input: {
  activeConversationId?: string | null;
  agentTargetId?: string | null;
  loadedSections: readonly ConversationRailSectionMembership[] | null;
  next: readonly ConversationRailMembershipRecord[];
  previous: readonly ConversationRailMembershipRecord[];
  searchActive?: boolean;
}): ConversationRailMembershipRefreshPlan {
  const targetId = input.agentTargetId?.trim() ?? "";
  const visible = (record: ConversationRailMembershipRecord) =>
    !targetId || record.agentTargetId?.trim() === targetId;
  const previousPendingIds = new Set(
    input.previous
      .filter(
        (record) =>
          record.projectionSource === "pending_activation" && visible(record)
      )
      .map((record) => record.id)
  );
  const canonical = (records: readonly ConversationRailMembershipRecord[]) =>
    new Map(
      records
        .filter(
          (record) =>
            record.projectionSource !== "pending_activation" && visible(record)
        )
        .map((record) => [record.id, record] as const)
    );
  const previousById = canonical(input.previous);
  const nextById = canonical(input.next);
  const loadedIds = new Set(
    (input.loadedSections ?? []).flatMap((section) => section.sessionIds)
  );
  const pageIds = new Set<string>();
  const reconcilingSessionIds: string[] = [];
  let refreshSearch = false;

  const addPage = (record: ConversationRailMembershipRecord) => {
    const pageId =
      record.pinnedAtUnixMs != null ? "pinned" : record.railSectionKey?.trim();
    if (pageId) pageIds.add(pageId);
  };

  for (const [id, previous] of previousById) {
    const next = nextById.get(id);
    if (!next) {
      addPage(previous);
      refreshSearch ||= Boolean(input.searchActive);
      continue;
    }
    if (
      (previous.pinnedAtUnixMs ?? 0) !== (next.pinnedAtUnixMs ?? 0) ||
      previous.railSectionKey !== next.railSectionKey
    ) {
      addPage(previous);
      addPage(next);
    }
    if (previous.title !== next.title) {
      refreshSearch ||= Boolean(input.searchActive);
    }
  }

  for (const [id, next] of nextById) {
    if (previousById.has(id)) continue;
    if (previousPendingIds.has(id)) {
      if (!loadedIds.has(id)) {
        addPage(next);
        reconcilingSessionIds.push(id);
      }
      continue;
    }
    if (
      id === (input.activeConversationId?.trim() ?? "") ||
      loadedIds.has(id)
    ) {
      continue;
    }
    addPage(next);
    refreshSearch ||= Boolean(input.searchActive);
  }

  return pageIds.size > 0 || refreshSearch
    ? {
        kind: "refresh_pages",
        pageIds: [...pageIds],
        reconcilingSessionIds,
        refreshSearch
      }
    : { kind: "none" };
}
