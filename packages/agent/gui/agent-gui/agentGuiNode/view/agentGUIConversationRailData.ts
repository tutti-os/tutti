import type {
  AgentActivityRuntimeSessionPage,
  AgentActivityRuntimeSessionSection
} from "../../../agentActivityRuntime";
import type { AgentGUIProvider } from "../../../types";
import type { AgentGUINodeViewModel } from "../model/agentGuiNodeTypes";
import type { AgentGUIViewLabels } from "../AgentGUINodeView";
import type { ConversationSection } from "../agentGuiNodeViewConversation";
import { buildAgentGUIConversationSummaries } from "../model/agentGuiConversationModel";

export const AGENT_GUI_CONVERSATION_RAIL_PROJECTION_PROVIDER: AgentGUIProvider =
  "codex";

export function normalizeConversationRailProjectPath(
  path: string | null | undefined
): string {
  const normalized = path?.trim().replaceAll("\\", "/") ?? "";
  if (!normalized) {
    return "";
  }
  return normalized.replace(/\/+$/, "") || "/";
}

export interface ConversationRailSectionPageState {
  hasMore: boolean;
  isLoading: boolean;
  nextCursor: string | null;
}

export function conversationRailPageCursor(
  conversations: readonly AgentGUINodeViewModel["rail"]["conversations"][number][]
): string | null {
  let boundary: AgentGUINodeViewModel["rail"]["conversations"][number] | null =
    null;
  for (const conversation of conversations) {
    if (!conversation.id.trim()) {
      continue;
    }
    if (!boundary) {
      boundary = conversation;
      continue;
    }
    if (
      conversation.updatedAtUnixMs < boundary.updatedAtUnixMs ||
      (conversation.updatedAtUnixMs === boundary.updatedAtUnixMs &&
        conversation.id.trim() > boundary.id.trim())
    ) {
      boundary = conversation;
    }
  }
  if (!boundary) {
    return null;
  }
  return `${boundary.updatedAtUnixMs}|${boundary.id.trim()}`;
}

export function mergeConversationRailPageItems(
  base: AgentGUINodeViewModel["rail"]["conversations"],
  loaded: AgentGUINodeViewModel["rail"]["conversations"]
): AgentGUINodeViewModel["rail"]["conversations"] {
  if (loaded.length === 0) {
    return base;
  }
  const ids = new Set(base.map((conversation) => conversation.id));
  const merged = [...base];
  for (const conversation of loaded) {
    if (ids.has(conversation.id)) {
      continue;
    }
    ids.add(conversation.id);
    merged.push(conversation);
  }
  return merged;
}

export function stabilizeConversationSections(
  previous: readonly ConversationSection[] | null,
  next: readonly ConversationSection[]
): ConversationSection[] {
  if (!previous) {
    return [...next];
  }
  const previousById = new Map(
    previous.map((section) => [section.id, section])
  );
  let changed = previous.length !== next.length;
  const stable = next.map((section, index) => {
    const previousSection = previousById.get(section.id) ?? null;
    if (!previousSection) {
      changed = true;
      return section;
    }
    const items = stabilizeConversationSectionItems(
      previousSection.items,
      section.items
    );
    const canReuseSection =
      previousSection.kind === section.kind &&
      previousSection.label === section.label &&
      conversationProjectsRenderEqual(
        previousSection.project,
        section.project
      ) &&
      items === previousSection.items;
    if (canReuseSection) {
      if (previous[index] !== previousSection) {
        changed = true;
      }
      return previousSection;
    }
    changed = true;
    return { ...section, items };
  });
  return changed ? stable : (previous as ConversationSection[]);
}

export function stabilizeConversationSectionItems(
  previous: AgentGUINodeViewModel["rail"]["conversations"],
  next: AgentGUINodeViewModel["rail"]["conversations"]
): AgentGUINodeViewModel["rail"]["conversations"] {
  if (previous.length !== next.length) {
    const previousById = new Map<
      string,
      AgentGUINodeViewModel["rail"]["conversations"][number]
    >();
    for (const item of previous) {
      if (!previousById.has(item.id)) {
        previousById.set(item.id, item);
      }
    }
    return next.map((item) => {
      const previousItem = previousById.get(item.id);
      return previousItem &&
        conversationSummariesRenderEqual(previousItem, item)
        ? previousItem
        : item;
    });
  }
  let changed = false;
  const stable = next.map((item, index) => {
    const previousItem = previous[index];
    if (previousItem && conversationSummariesRenderEqual(previousItem, item)) {
      return previousItem;
    }
    changed = true;
    return item;
  });
  return changed ? stable : previous;
}

export function updateConversationSectionsFromSummaries(
  previous: ConversationSection[] | null,
  conversations: readonly AgentGUINodeViewModel["rail"]["conversations"][number][],
  options: { sectionConversationsLabel: string; sectionPinnedLabel?: string }
): ConversationSection[] | null {
  if (!previous || conversations.length === 0) {
    return previous;
  }
  const summariesById = new Map(
    conversations.map((conversation) => [conversation.id, conversation])
  );
  const summarySectionItemsById = new Map<
    string,
    AgentGUINodeViewModel["rail"]["conversations"]
  >();
  for (const conversation of conversations) {
    if ((conversation.pinnedAtUnixMs ?? 0) > 0) {
      continue;
    }
    if (conversation.project) {
      continue;
    }
    const sectionId = "conversations";
    const items = summarySectionItemsById.get(sectionId) ?? [];
    items.push(conversation);
    summarySectionItemsById.set(sectionId, items);
  }
  const seenIds = new Set<string>();
  let changed = false;
  const nextSections = previous.map((section) => {
    let sectionChanged = false;
    if (section.kind === "pinned") {
      const pinnedSummaryItems = conversations.filter(
        (conversation) => (conversation.pinnedAtUnixMs ?? 0) > 0
      );
      const items = section.items
        .map((item) => {
          seenIds.add(item.id);
          const summary = summariesById.get(item.id);
          if (!summary) {
            return item;
          }
          if ((summary.pinnedAtUnixMs ?? 0) <= 0) {
            sectionChanged = true;
            return null;
          }
          if (conversationSummariesRenderEqual(item, summary)) {
            return item;
          }
          sectionChanged = true;
          return summary;
        })
        .filter(
          (
            item
          ): item is AgentGUINodeViewModel["rail"]["conversations"][number] =>
            item !== null
        );
      const existingIds = new Set(items.map((item) => item.id));
      const mergedItems = [
        ...items,
        ...pinnedSummaryItems.filter((item) => !existingIds.has(item.id))
      ];
      if (mergedItems.length !== items.length) {
        sectionChanged = true;
      }
      for (const item of pinnedSummaryItems) {
        seenIds.add(item.id);
      }
      const stableItems = stabilizeConversationSectionItems(
        section.items,
        sortPinnedConversations(mergedItems)
      );
      if (!sectionChanged && stableItems === section.items) {
        return section;
      }
      changed = true;
      return {
        ...section,
        items: stableItems
      };
    }
    const summaryItems = summarySectionItemsById.get(section.id) ?? [];
    const items = section.items
      .map((item) => {
        seenIds.add(item.id);
        const summary = summariesById.get(item.id);
        if (!summary) {
          return item;
        }
        if ((summary.pinnedAtUnixMs ?? 0) > 0) {
          sectionChanged = true;
          return null;
        }
        const nextItem = section.project
          ? {
              ...summary,
              project: section.project
            }
          : {
              ...summary,
              project: null
            };
        if (conversationSummariesRenderEqual(item, nextItem)) {
          return item;
        }
        sectionChanged = true;
        return nextItem;
      })
      .filter(
        (
          item
        ): item is AgentGUINodeViewModel["rail"]["conversations"][number] =>
          item !== null
      );
    const nextSection = sectionChanged
      ? {
          ...section,
          items
        }
      : section;
    if (summaryItems.length === 0) {
      if (sectionChanged) {
        changed = true;
      }
      return nextSection;
    }
    const summaryIds = new Set(summaryItems.map((item) => item.id));
    const mergedItems = [
      ...summaryItems.map((item) =>
        section.project ? { ...item, project: section.project } : item
      ),
      ...items.filter((item) => !summaryIds.has(item.id))
    ];
    const stableItems = stabilizeConversationSectionItems(
      section.items,
      mergedItems
    );
    if (stableItems === section.items) {
      if (sectionChanged) {
        changed = true;
      }
      return nextSection;
    }
    changed = true;
    return {
      ...nextSection,
      items: stableItems
    };
  });

  // A conversation can go from not-existing to existing between two runtime
  // section fetches (e.g. the optimistic pre-activation entry created by
  // the first-message flow, whose id never changes once the real backend
  // session lands). The loop above only patches items that are already
  // present in some section; without this, such a conversation would never
  // appear in the sidebar until the next full runtimeListSessionSections
  // refetch happens to include it, which -- because that refetch is keyed
  // off conversation membership -- may never happen again for the same id.
  const existingSectionIds = new Set(nextSections.map((section) => section.id));
  const newPinnedConversations =
    existingSectionIds.has("pinned") || !options.sectionPinnedLabel
      ? []
      : conversations.filter(
          (conversation) =>
            (conversation.pinnedAtUnixMs ?? 0) > 0 &&
            !seenIds.has(conversation.id)
        );
  const newConversations = [...summarySectionItemsById.entries()].flatMap(
    ([sectionId, items]) =>
      existingSectionIds.has(sectionId)
        ? []
        : items.filter((conversation) => !seenIds.has(conversation.id))
  );
  if (newPinnedConversations.length === 0 && newConversations.length === 0) {
    return changed ? nextSections : previous;
  }

  const sectionsWithInsertions = [...nextSections];
  if (newPinnedConversations.length > 0 && options.sectionPinnedLabel) {
    sectionsWithInsertions.unshift({
      id: "pinned",
      kind: "pinned",
      label: options.sectionPinnedLabel,
      project: null,
      items: sortPinnedConversations(newPinnedConversations)
    });
  }
  for (const conversation of newConversations) {
    const targetSectionId = "conversations";
    const targetIndex = sectionsWithInsertions.findIndex(
      (section) => section.id === targetSectionId
    );
    const target =
      targetIndex !== -1 ? sectionsWithInsertions[targetIndex] : undefined;
    if (targetIndex !== -1 && target) {
      sectionsWithInsertions[targetIndex] = {
        ...target,
        items: [...target.items, conversation]
      };
      continue;
    }
    sectionsWithInsertions.push({
      id: targetSectionId,
      kind: "conversations",
      label: options.sectionConversationsLabel,
      project: null,
      items: [conversation]
    });
  }
  return sectionsWithInsertions;
}

export function sortPinnedConversations(
  conversations: AgentGUINodeViewModel["rail"]["conversations"]
): AgentGUINodeViewModel["rail"]["conversations"] {
  return [...conversations].sort(
    (left, right) =>
      (right.pinnedAtUnixMs ?? 0) - (left.pinnedAtUnixMs ?? 0) ||
      (right.sortTimeUnixMs ?? right.updatedAtUnixMs) -
        (left.sortTimeUnixMs ?? left.updatedAtUnixMs) ||
      left.id.localeCompare(right.id)
  );
}

export function projectRuntimeSectionsToConversationSections(input: {
  conversationFilter: Parameters<
    typeof buildAgentGUIConversationSummaries
  >[0]["conversationFilter"];
  labels: Pick<AgentGUIViewLabels, "sectionPinned" | "sectionConversations">;
  pinned?: AgentActivityRuntimeSessionPage;
  sections: readonly AgentActivityRuntimeSessionSection[];
  workspaceId: string;
}): ConversationSection[] {
  const pinned: AgentGUINodeViewModel["rail"]["conversations"] = input.pinned
    ? buildAgentGUIConversationSummaries({
        conversationFilter: input.conversationFilter,
        provider: AGENT_GUI_CONVERSATION_RAIL_PROJECTION_PROVIDER,
        snapshot: {
          composerOptionsByTargetKey: {},
          presences: [],
          sessionMessagesById: {},
          sessions: input.pinned.sessions,
          workspaceId: input.workspaceId
        },
        userProjects: []
      }).filter((conversation) => (conversation.pinnedAtUnixMs ?? 0) > 0)
    : [];
  const result: ConversationSection[] = [];
  for (const section of input.sections) {
    const project = section.userProject
      ? {
          createdAtUnixMs: section.userProject.createdAtUnixMs,
          id: section.userProject.id,
          label: section.userProject.label,
          lastUsedAtUnixMs: section.userProject.lastUsedAtUnixMs,
          path: section.userProject.path,
          updatedAtUnixMs: section.userProject.updatedAtUnixMs
        }
      : null;
    const conversations = buildAgentGUIConversationSummaries({
      conversationFilter: input.conversationFilter,
      provider: AGENT_GUI_CONVERSATION_RAIL_PROJECTION_PROVIDER,
      snapshot: {
        composerOptionsByTargetKey: {},
        presences: [],
        sessionMessagesById: {},
        sessions: section.sessions,
        workspaceId: input.workspaceId
      },
      userProjects: []
    }).map((conversation) => ({
      ...conversation,
      project: section.kind === "project" ? project : null
    }));
    const items = conversations.filter((conversation) => {
      if ((conversation.pinnedAtUnixMs ?? 0) > 0) {
        pinned.push(conversation);
        return false;
      }
      return true;
    });
    result.push({
      id: section.sectionKey,
      kind: section.kind,
      label:
        section.kind === "project"
          ? (section.userProject?.label ?? section.sectionKey)
          : input.labels.sectionConversations,
      project,
      items
    });
  }
  if (pinned.length > 0) {
    const pinnedById = new Map<
      string,
      AgentGUINodeViewModel["rail"]["conversations"][number]
    >();
    for (const conversation of pinned) {
      pinnedById.set(conversation.id, conversation);
    }
    result.unshift({
      id: "pinned",
      kind: "pinned",
      label: input.labels.sectionPinned,
      project: null,
      items: sortPinnedConversations([...pinnedById.values()])
    });
  }
  return result;
}

export function conversationSummariesRenderEqual(
  left: AgentGUINodeViewModel["rail"]["conversations"][number],
  right: AgentGUINodeViewModel["rail"]["conversations"][number]
): boolean {
  return (
    left.id === right.id &&
    left.agentTargetId === right.agentTargetId &&
    left.provider === right.provider &&
    left.title === right.title &&
    left.titleFallback === right.titleFallback &&
    left.status === right.status &&
    left.cwd === right.cwd &&
    left.pinnedAtUnixMs === right.pinnedAtUnixMs &&
    left.sortTimeUnixMs === right.sortTimeUnixMs &&
    left.updatedAtUnixMs === right.updatedAtUnixMs &&
    left.isImported === right.isImported &&
    left.hasUnreadCompletion === right.hasUnreadCompletion &&
    left.unreadCompletionKey === right.unreadCompletionKey &&
    conversationProjectsRenderEqual(left.project, right.project)
  );
}

export function conversationProjectsRenderEqual(
  left: AgentGUINodeViewModel["rail"]["conversations"][number]["project"],
  right: AgentGUINodeViewModel["rail"]["conversations"][number]["project"]
): boolean {
  return (
    left === right ||
    (!left || !right
      ? !left && !right
      : left.id === right.id &&
        left.path === right.path &&
        left.label === right.label &&
        left.createdAtUnixMs === right.createdAtUnixMs &&
        left.updatedAtUnixMs === right.updatedAtUnixMs &&
        left.lastUsedAtUnixMs === right.lastUsedAtUnixMs)
  );
}
