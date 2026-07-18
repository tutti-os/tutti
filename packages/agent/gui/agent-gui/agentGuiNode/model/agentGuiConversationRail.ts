import type {
  AgentActivityRuntimeSessionPage,
  AgentActivityRuntimeSessionSection
} from "../../../agentActivityRuntime";
import type { AgentGUINodeViewModel } from "./agentGuiNodeTypes";
import type { ConversationSection } from "../agentGuiNodeViewConversation";
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

export {
  planRuntimeRailMembershipRefresh,
  type ConversationRailMembershipRecord,
  type ConversationRailMembershipRefreshPlan
} from "./agentGuiConversationRailMembershipRefresh";

export function isConversationRailInitialLoadPending(input: {
  pending: boolean;
  runtimeSectionsEnabled: boolean;
  sections: ConversationRailSectionMembership[] | null;
}): boolean {
  return (
    input.runtimeSectionsEnabled && input.pending && input.sections === null
  );
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

export function isConversationRailProjectPinned(
  project: ConversationSection["project"]
): boolean {
  return (project?.pinnedAtUnixMs ?? 0) > 0;
}

export function conversationRailSectionHeaderVisibility(
  sections: readonly ConversationSection[],
  sectionIndex: number
): { showPinnedHeader: boolean; showProjectsHeader: boolean } {
  const section = sections[sectionIndex];
  if (!section) {
    return { showPinnedHeader: false, showProjectsHeader: false };
  }
  const sectionIsPinnedProject =
    section.kind === "project" &&
    isConversationRailProjectPinned(section.project);
  const precedingSections = sections.slice(0, sectionIndex);
  return {
    showPinnedHeader:
      sectionIsPinnedProject &&
      !precedingSections.some(
        (candidate) =>
          candidate.kind === "pinned" ||
          (candidate.kind === "project" &&
            isConversationRailProjectPinned(candidate.project))
      ),
    showProjectsHeader:
      section.kind !== "pinned" &&
      !sectionIsPinnedProject &&
      !precedingSections.some(
        (candidate) =>
          candidate.kind === "project" &&
          !isConversationRailProjectPinned(candidate.project)
      )
  };
}

export function partitionConversationRailUserProjects<
  T extends { pinnedAtUnixMs: number }
>(projects: readonly T[]): T[] {
  return [
    ...projects.filter((project) => project.pinnedAtUnixMs > 0),
    ...projects.filter((project) => project.pinnedAtUnixMs <= 0)
  ];
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
  const transientSections = projectConversationsByExactRailSectionKey({
    conversations: transientConversations.filter(
      (conversation) => !loadedIds.has(conversation.id)
    ),
    labels: input.labels,
    sections: input.sections
  });
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

  const activeSectionId = conversationRailSectionId(activeConversation);
  if (!activeSectionId) {
    return { activeOverlay: null, sections: input.sections };
  }
  const matchingSection = input.sections.find(
    (section) => section.id === activeSectionId
  );
  if (matchingSection) {
    return {
      activeOverlay: {
        conversation:
          matchingSection.kind === "project"
            ? conversationWithRailProject(
                activeConversation,
                matchingSection.project
              )
            : activeConversation,
        sectionId: matchingSection.id
      },
      sections: input.sections
    };
  }

  const activeSection = createExactConversationRailSection(
    activeConversation,
    input.labels
  );
  if (!activeSection) {
    return { activeOverlay: null, sections: input.sections };
  }
  const projectedConversation = activeSection.items[0] ?? activeConversation;

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
      conversation: projectedConversation,
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

function conversationRailSectionId(
  conversation: AgentGUINodeViewModel["rail"]["conversations"][number]
): string | null {
  if ((conversation.pinnedAtUnixMs ?? 0) > 0) {
    return "pinned";
  }
  const sectionKey = conversation.railSectionKey?.trim() ?? "";
  return sectionKey || null;
}

function createExactConversationRailSection(
  conversation: AgentGUINodeViewModel["rail"]["conversations"][number],
  labels: ConversationRailLabels
): ConversationSection | null {
  const sectionId = conversationRailSectionId(conversation);
  if (!sectionId) {
    return null;
  }
  if (sectionId === "pinned") {
    return {
      id: sectionId,
      kind: "pinned",
      label: labels.sectionPinned,
      project: null,
      items: [{ ...conversation, project: null }]
    };
  }
  if (sectionId === "conversations") {
    return {
      id: sectionId,
      kind: "conversations",
      label: labels.sectionConversations,
      project: null,
      items: [{ ...conversation, project: null }]
    };
  }
  const project = conversation.project;
  if (project?.sectionKey?.trim() !== sectionId) {
    return null;
  }
  return {
    id: sectionId,
    kind: "project",
    label: project.label,
    project,
    items: [conversationWithRailProject(conversation, project)]
  };
}

function projectConversationsByExactRailSectionKey(input: {
  conversations: AgentGUINodeViewModel["rail"]["conversations"];
  labels: ConversationRailLabels;
  sections: readonly ConversationSection[];
  includeEmptySections?: boolean;
}): ConversationSection[] {
  const sectionTemplates = new Map(
    input.sections.map((section) => [section.id, section] as const)
  );
  const projected = new Map<string, ConversationSection>();
  if (input.includeEmptySections) {
    for (const section of input.sections) {
      if (section.kind === "pinned") continue;
      projected.set(section.id, { ...section, items: [] });
    }
  }
  for (const conversation of input.conversations) {
    const sectionId = conversationRailSectionId(conversation);
    if (!sectionId) continue;
    const template = sectionTemplates.get(sectionId);
    const section =
      template ??
      createExactConversationRailSection(conversation, input.labels);
    if (!section) continue;
    const projectedConversation =
      section.kind === "project"
        ? conversationWithRailProject(conversation, section.project)
        : conversation.project
          ? { ...conversation, project: null }
          : conversation;
    const existing = projected.get(sectionId);
    if (existing) {
      existing.items.push(projectedConversation);
      continue;
    }
    projected.set(sectionId, {
      ...section,
      items: [projectedConversation]
    });
  }
  const sorted = new Map(
    [...projected].map(([id, section]) => [
      id,
      {
        ...section,
        items:
          section.kind === "pinned"
            ? sortPinnedConversations(section.items)
            : sortConversations(section.items)
      }
    ])
  );
  const result: ConversationSection[] = [];
  const append = (id: string) => {
    const section = sorted.get(id);
    if (!section) return;
    result.push(section);
    sorted.delete(id);
  };
  append("pinned");
  for (const section of input.sections) {
    if (section.kind === "pinned" || section.kind === "conversations") {
      continue;
    }
    append(section.id);
  }
  [...sorted.values()]
    .filter((section) => section.kind === "project")
    .sort((left, right) => left.id.localeCompare(right.id))
    .forEach((section) => append(section.id));
  for (const section of input.sections) {
    if (section.kind === "conversations") append(section.id);
  }
  append("conversations");
  [...sorted.keys()].sort().forEach(append);
  return result;
}

export function projectConversationRailSectionsByExactKey(input: {
  conversations: AgentGUINodeViewModel["rail"]["conversations"];
  labels: ConversationRailLabels;
  userProjects: AgentGUINodeViewModel["rail"]["userProjects"];
  includeEmptySections?: boolean;
}): ConversationSection[] {
  const seen = new Set<string>();
  const sections: ConversationSection[] = partitionConversationRailUserProjects(
    input.userProjects
  ).flatMap((project) => {
    const sectionKey = project.sectionKey?.trim() ?? "";
    if (!sectionKey || seen.has(sectionKey)) return [];
    seen.add(sectionKey);
    return [
      {
        id: sectionKey,
        kind: "project" as const,
        label: project.label,
        project,
        items: []
      }
    ];
  });
  sections.push({
    id: "conversations",
    kind: "conversations",
    label: input.labels.sectionConversations,
    project: null,
    items: []
  });
  return projectConversationsByExactRailSectionKey({
    conversations: input.conversations,
    labels: input.labels,
    sections,
    includeEmptySections: true
  });
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
          pinnedAtUnixMs: section.userProject.pinnedAtUnixMs,
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
      const exactSectionId = conversationRailSectionId(conversation);
      if (exactSectionId !== section.id) return [];
      return [
        section.kind === "project"
          ? { ...conversation, project: section.project }
          : { ...conversation, project: null }
      ];
    })
  }));
}

export function projectConversationRailSearchSections(input: {
  conversations: AgentGUINodeViewModel["rail"]["conversations"];
  labels: ConversationRailLabels;
  sections: readonly ConversationSection[];
}): ConversationSection[] {
  return projectConversationsByExactRailSectionKey({
    ...input,
    includeEmptySections: true
  });
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
    left.titleLeadingMentionKind === right.titleLeadingMentionKind &&
    left.titleFallback === right.titleFallback &&
    left.status === right.status &&
    left.cwd === right.cwd &&
    left.railSectionKey === right.railSectionKey &&
    left.pinnedAtUnixMs === right.pinnedAtUnixMs &&
    left.sortTimeUnixMs === right.sortTimeUnixMs &&
    left.updatedAtUnixMs === right.updatedAtUnixMs &&
    left.projectionSource === right.projectionSource &&
    left.isImported === right.isImported &&
    left.hasUnreadCompletion === right.hasUnreadCompletion &&
    left.unreadCompletionKey === right.unreadCompletionKey &&
    left.needsUserAction === right.needsUserAction &&
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
        left.sectionKey === right.sectionKey &&
        left.label === right.label &&
        left.createdAtUnixMs === right.createdAtUnixMs &&
        left.updatedAtUnixMs === right.updatedAtUnixMs &&
        left.lastUsedAtUnixMs === right.lastUsedAtUnixMs &&
        left.pinnedAtUnixMs === right.pinnedAtUnixMs &&
        left.sectionKey === right.sectionKey)
  );
}
