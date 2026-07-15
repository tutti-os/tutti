import type {
  AgentActivityRuntimeSessionPage,
  AgentActivityRuntimeSessionSection
} from "../../../agentActivityRuntime";
import type { AgentGUINodeViewModel } from "./agentGuiNodeTypes";
import {
  groupConversations,
  type ConversationSection
} from "../agentGuiNodeViewConversation";
import { resolveAgentGUIConversationSortTimeUnixMs } from "./agentGuiConversationModel";
import { normalizeAgentGUIProjectPath } from "./agentGuiConversationProjectResolver";

export interface ConversationRailLabels {
  sectionConversations: string;
  sectionPinned: string;
}

export function normalizeConversationRailProjectPath(
  path: string | null | undefined
): string {
  return normalizeAgentGUIProjectPath(path);
}

export interface ConversationRailSectionPageState {
  hasMore: boolean;
  isLoading: boolean;
  nextCursor: string | null;
  totalCount: number;
}

export interface ConversationRailSectionMembership {
  id: string;
  kind: ConversationSection["kind"];
  project: ConversationSection["project"];
  sessionIds: readonly string[];
}

export interface ConversationRailQueryState {
  pending: boolean;
  reconcilingSessionIds: readonly string[];
  resolvedScopeKey: string | null;
  sectionPageStates: ReadonlyMap<string, ConversationRailSectionPageState>;
  sections: ConversationRailSectionMembership[] | null;
}

export interface ConversationRailActiveOverlay {
  conversation: NonNullable<
    AgentGUINodeViewModel["rail"]["activeConversation"]
  >;
  sectionId: string;
}

export interface ConversationRailDisplayProjection {
  activeOverlay: ConversationRailActiveOverlay | null;
  sections: ConversationSection[];
}

export function canonicalConversationRailSummaries(
  conversations: AgentGUINodeViewModel["rail"]["conversations"]
): AgentGUINodeViewModel["rail"]["conversations"] {
  return conversations.filter(
    (conversation) => conversation.projectionSource !== "pending_activation"
  );
}

export function projectConversationRailSectionsWithTransientConversations(input: {
  conversations: AgentGUINodeViewModel["rail"]["conversations"];
  labels: ConversationRailLabels;
  reconcilingSessionIds: readonly string[];
  sections: ConversationSection[];
}): ConversationSection[] {
  const reconcilingSessionIds = new Set(input.reconcilingSessionIds);
  const transientConversations = input.conversations.filter(
    (conversation) =>
      conversation.projectionSource === "pending_activation" ||
      reconcilingSessionIds.has(conversation.id)
  );
  if (transientConversations.length === 0) {
    return input.sections;
  }
  const loadedIds = new Set(
    input.sections.flatMap((section) => section.items.map((item) => item.id))
  );
  const transientSections = groupConversations(
    transientConversations.filter(
      (conversation) => !loadedIds.has(conversation.id)
    ),
    input.labels
  );
  if (transientSections.length === 0) {
    return input.sections;
  }
  const sections = [...input.sections];
  for (const transientSection of transientSections) {
    const matchingIndex = sections.findIndex(
      (section) => section.id === transientSection.id
    );
    if (matchingIndex >= 0) {
      const matching = sections[matchingIndex];
      if (!matching) continue;
      const transientIds = new Set(
        transientSection.items.map((item) => item.id)
      );
      sections[matchingIndex] = {
        ...matching,
        items:
          matching.kind === "pinned"
            ? sortPinnedConversations([
                ...transientSection.items,
                ...matching.items.filter((item) => !transientIds.has(item.id))
              ])
            : sortConversations([
                ...transientSection.items.map((item) =>
                  matching.project
                    ? { ...item, project: matching.project }
                    : item
                ),
                ...matching.items.filter((item) => !transientIds.has(item.id))
              ])
      };
      continue;
    }
    if (transientSection.kind === "pinned") {
      sections.unshift(transientSection);
      continue;
    }
    const conversationsIndex = sections.findIndex(
      (section) => section.kind === "conversations"
    );
    if (transientSection.kind === "project" && conversationsIndex >= 0) {
      sections.splice(conversationsIndex, 0, transientSection);
    } else {
      sections.push(transientSection);
    }
  }
  return sections;
}

export function resolveConversationRailActiveConversation(input: {
  activeConversation: AgentGUINodeViewModel["rail"]["activeConversation"];
  activeConversationId: string | null;
  conversations: AgentGUINodeViewModel["rail"]["conversations"];
}): AgentGUINodeViewModel["rail"]["activeConversation"] {
  const activeConversationId = input.activeConversationId?.trim() ?? "";
  if (!activeConversationId) {
    return null;
  }
  return (
    input.conversations.find(
      (conversation) => conversation.id === activeConversationId
    ) ??
    (input.activeConversation?.id === activeConversationId
      ? input.activeConversation
      : null)
  );
}

export function projectConversationRailSectionsWithActiveConversation(input: {
  activeConversation: AgentGUINodeViewModel["rail"]["activeConversation"];
  labels: ConversationRailLabels;
  sections: ConversationSection[];
}): ConversationRailDisplayProjection {
  const activeConversation = input.activeConversation;
  const activeConversationId = activeConversation?.id.trim() ?? "";
  if (!activeConversation || !activeConversationId) {
    return { activeOverlay: null, sections: input.sections };
  }

  const loadedSection = input.sections.find((section) =>
    section.items.some((item) => item.id === activeConversationId)
  );
  if (loadedSection) {
    return {
      activeOverlay: {
        conversation:
          loadedSection.kind === "project"
            ? conversationWithRailProject(
                activeConversation,
                loadedSection.project
              )
            : activeConversation,
        sectionId: loadedSection.id
      },
      sections: input.sections
    };
  }

  const activeSection = groupConversations(
    [activeConversation],
    input.labels
  )[0];
  if (!activeSection) {
    return { activeOverlay: null, sections: input.sections };
  }

  const matchingSectionIndex = input.sections.findIndex(
    (section) => section.id === activeSection.id
  );
  if (matchingSectionIndex >= 0) {
    const matchingSection = input.sections[matchingSectionIndex];
    return {
      activeOverlay: {
        conversation:
          matchingSection?.kind === "project"
            ? conversationWithRailProject(
                activeConversation,
                matchingSection.project
              )
            : activeConversation,
        sectionId: activeSection.id
      },
      sections: input.sections
    };
  }

  const transientSection = { ...activeSection, items: [] };
  let sections: ConversationSection[];

  if (activeSection.kind === "pinned") {
    sections = [transientSection, ...input.sections];
  } else if (activeSection.kind === "project") {
    const conversationsSectionIndex = input.sections.findIndex(
      (section) => section.kind === "conversations"
    );
    if (conversationsSectionIndex >= 0) {
      sections = [
        ...input.sections.slice(0, conversationsSectionIndex),
        transientSection,
        ...input.sections.slice(conversationsSectionIndex)
      ];
    } else {
      sections = [...input.sections, transientSection];
    }
  } else {
    sections = [...input.sections, transientSection];
  }
  return {
    activeOverlay: {
      conversation: activeConversation,
      sectionId: activeSection.id
    },
    sections
  };
}

function conversationWithRailProject(
  conversation: AgentGUINodeViewModel["rail"]["conversations"][number],
  project: ConversationSection["project"]
): AgentGUINodeViewModel["rail"]["conversations"][number] {
  return conversationProjectsRenderEqual(conversation.project, project)
    ? conversation
    : { ...conversation, project };
}

export type ConversationRailMembershipRefreshPlan =
  | { kind: "none" }
  | {
      kind: "refresh_first_pages";
      reconcilingSessionIds: readonly string[];
    };

export interface ConversationRailMembershipRecord {
  id: string;
  pinnedAtUnixMs?: number | null;
  projectionSource?: "pending_activation";
}

export function planRuntimeRailMembershipRefresh(input: {
  activeConversationId?: string | null;
  loadedSections: readonly ConversationRailSectionMembership[] | null;
  next: readonly ConversationRailMembershipRecord[];
  previous: readonly ConversationRailMembershipRecord[];
}): ConversationRailMembershipRefreshPlan {
  const previousPendingIds = new Set(
    input.previous.flatMap((conversation) => {
      const id = conversation.id.trim();
      return conversation.projectionSource === "pending_activation" && id
        ? [id]
        : [];
    })
  );
  const previousConversations = input.previous.filter(
    (conversation) => conversation.projectionSource !== "pending_activation"
  );
  const nextConversations = input.next.filter(
    (conversation) => conversation.projectionSource !== "pending_activation"
  );
  const previousById = new Map(
    previousConversations.flatMap((conversation) => {
      const id = conversation.id.trim();
      return id ? [[id, conversation] as const] : [];
    })
  );
  const nextById = new Map(
    nextConversations.flatMap((conversation) => {
      const id = conversation.id.trim();
      return id ? [[id, conversation] as const] : [];
    })
  );
  const loadedIds = new Set(
    (input.loadedSections ?? []).flatMap((section) =>
      section.sessionIds.map((id) => id.trim()).filter(Boolean)
    )
  );

  let requiresRefresh = false;
  const reconcilingSessionIds: string[] = [];
  for (const id of previousById.keys()) {
    if (!nextById.has(id)) {
      requiresRefresh = true;
    }
  }
  for (const [id, conversation] of nextById) {
    const previous = previousById.get(id);
    if (!previous) {
      if (previousPendingIds.has(id)) {
        if (!loadedIds.has(id)) {
          requiresRefresh = true;
          reconcilingSessionIds.push(id);
        }
        continue;
      }
      if (id === (input.activeConversationId?.trim() ?? "")) {
        continue;
      }
      // Section pages can expose historical rows outside the engine's bounded
      // session snapshot. Hydrating one of those rows adds an entity, not rail
      // membership; keep every already-loaded page and cursor intact.
      if (!loadedIds.has(id)) {
        requiresRefresh = true;
      }
      continue;
    }
    if ((previous.pinnedAtUnixMs ?? 0) !== (conversation.pinnedAtUnixMs ?? 0)) {
      requiresRefresh = true;
    }
  }
  return requiresRefresh
    ? {
        kind: "refresh_first_pages",
        reconcilingSessionIds
      }
    : { kind: "none" };
}

export function mergeConversationRailSessionIds(
  base: readonly string[],
  loaded: readonly string[]
): readonly string[] {
  const ids = new Set(base);
  const merged = [...base];
  for (const rawId of loaded) {
    const id = rawId.trim();
    if (!id || ids.has(id)) continue;
    ids.add(id);
    merged.push(id);
  }
  return merged;
}

export function projectRuntimeSectionsToConversationRailMemberships(input: {
  pinned?: AgentActivityRuntimeSessionPage;
  sections: readonly AgentActivityRuntimeSessionSection[];
}): ConversationRailSectionMembership[] {
  const result: ConversationRailSectionMembership[] = [];
  if (input.pinned && input.pinned.sessions.length > 0) {
    result.push({
      id: "pinned",
      kind: "pinned",
      project: null,
      sessionIds: input.pinned.sessions.map((session) => session.agentSessionId)
    });
  }
  for (const section of input.sections) {
    const project = section.userProject
      ? {
          createdAtUnixMs: section.userProject.createdAtUnixMs,
          id: section.userProject.id,
          label: section.userProject.label,
          lastUsedAtUnixMs: section.userProject.lastUsedAtUnixMs,
          path: section.userProject.path,
          sectionKey: section.userProject.sectionKey,
          updatedAtUnixMs: section.userProject.updatedAtUnixMs
        }
      : null;
    result.push({
      id: section.sectionKey,
      kind: section.kind,
      project,
      sessionIds: section.sessions.map((session) => session.agentSessionId)
    });
  }
  return result;
}

export function projectConversationRailMemberships(input: {
  conversations: AgentGUINodeViewModel["rail"]["conversations"];
  labels: ConversationRailLabels;
  sections: readonly ConversationRailSectionMembership[];
}): ConversationSection[] {
  const conversationsById = new Map(
    canonicalConversationRailSummaries(input.conversations).map(
      (conversation) => [conversation.id, conversation] as const
    )
  );
  return input.sections.map((section) => ({
    id: section.id,
    kind: section.kind,
    label:
      section.kind === "pinned"
        ? input.labels.sectionPinned
        : section.kind === "project"
          ? (section.project?.label ?? section.id)
          : input.labels.sectionConversations,
    project: section.project,
    items: section.sessionIds.flatMap((id) => {
      const conversation = conversationsById.get(id);
      if (!conversation) return [];
      return [
        section.kind === "project"
          ? { ...conversation, project: section.project }
          : { ...conversation, project: null }
      ];
    })
  }));
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

export function sortConversations(
  conversations: AgentGUINodeViewModel["rail"]["conversations"]
): AgentGUINodeViewModel["rail"]["conversations"] {
  return [...conversations].sort(compareConversations);
}

export function sortPinnedConversations(
  conversations: AgentGUINodeViewModel["rail"]["conversations"]
): AgentGUINodeViewModel["rail"]["conversations"] {
  return [...conversations].sort(comparePinnedConversations);
}

export function insertConversationRailSectionOverlay(
  kind: ConversationSection["kind"],
  conversations: AgentGUINodeViewModel["rail"]["conversations"],
  overlay: AgentGUINodeViewModel["rail"]["conversations"][number]
): AgentGUINodeViewModel["rail"]["conversations"] {
  if (conversations.some((conversation) => conversation.id === overlay.id)) {
    return conversations;
  }
  const compare =
    kind === "pinned" ? comparePinnedConversations : compareConversations;
  const insertionIndex = conversations.findIndex(
    (conversation) => compare(overlay, conversation) < 0
  );
  if (insertionIndex < 0) {
    return [...conversations, overlay];
  }
  return [
    ...conversations.slice(0, insertionIndex),
    overlay,
    ...conversations.slice(insertionIndex)
  ];
}

function compareConversations(
  left: AgentGUINodeViewModel["rail"]["conversations"][number],
  right: AgentGUINodeViewModel["rail"]["conversations"][number]
): number {
  return (
    resolveAgentGUIConversationSortTimeUnixMs(right) -
      resolveAgentGUIConversationSortTimeUnixMs(left) ||
    left.id.localeCompare(right.id)
  );
}

function comparePinnedConversations(
  left: AgentGUINodeViewModel["rail"]["conversations"][number],
  right: AgentGUINodeViewModel["rail"]["conversations"][number]
): number {
  return (
    (right.pinnedAtUnixMs ?? 0) - (left.pinnedAtUnixMs ?? 0) ||
    (right.sortTimeUnixMs ?? right.updatedAtUnixMs) -
      (left.sortTimeUnixMs ?? left.updatedAtUnixMs) ||
    left.id.localeCompare(right.id)
  );
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
    left.projectionSource === right.projectionSource &&
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
        left.lastUsedAtUnixMs === right.lastUsedAtUnixMs &&
        left.sectionKey === right.sectionKey)
  );
}
