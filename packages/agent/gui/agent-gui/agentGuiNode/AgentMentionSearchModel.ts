import { createRichTextMentionHref } from "@tutti-os/ui-rich-text/core";
import { getOptionalAgentHostApi } from "../../agentActivityHost";
import type { AgentContextMentionItem } from "./agentRichText/agentFileMentionExtension";
import { normalizeAgentSessionMentionTitle } from "./agentRichText/agentFileMentionExtension";
import type { AgentContextMentionInsertResult } from "./agentContextMentionProvider";
import type { AgentMentionProviderQueryDiagnostic } from "./agentMentionSearchDiagnostics";
import type {
  AgentMentionFilterId,
  AgentMentionGroup,
  AgentMentionGroupId,
  AgentMentionIssueTopicGroup,
  AgentMentionRawGroups,
  AgentMentionTotalCounts
} from "./AgentMentionSearchContracts";
import {
  AGENT_GENERATED_FILE_PROVIDER_ID,
  AGENT_MENTION_LIFECYCLE_LOG_PREFIX,
  AGENT_SESSION_PROVIDER_ID,
  AGENT_TARGET_PROVIDER_ID,
  FILE_PROVIDER_ID,
  WORKSPACE_APP_PROVIDER_ID,
  WORKSPACE_ISSUE_PROVIDER_ID,
  type AgentMentionLifecycleDiagnosticLog
} from "./AgentMentionSearchContracts";
import { presentAgentGeneratedFileMentionItems } from "./agentMentionAgentGeneratedFilesPresentation";
import type {
  ReferenceProvenanceCatalog,
  ReferenceProvenanceFilter
} from "@tutti-os/workspace-file-reference/contracts";
import {
  buildEmptyGroup,
  compactText,
  groupIdsForFilter,
  mentionGroupPageSize,
  resolveMentionGroupItems,
  resolveMentionGroupTotalCount,
  shouldShowEmptyGroup
} from "./agentMentionSearchHelpers";

type AgentProvenanceMentionItem = Extract<
  AgentContextMentionItem,
  { kind: "session" | "agent-target" }
>;

export function buildAgentMentionGroups(input: {
  agentGeneratedBrowsePath: string | null;
  currentFileSearchLimit: number;
  currentFilter: AgentMentionFilterId;
  currentQuery: string;
  expandedCounts: Partial<Record<AgentMentionGroupId, number>>;
  issueTopicGroups: readonly AgentMentionIssueTopicGroup[] | null;
  rawGroups: AgentMentionRawGroups;
  totalCounts: AgentMentionTotalCounts;
  provenanceCatalog: ReferenceProvenanceCatalog | null;
  provenanceFilter: ReferenceProvenanceFilter | null;
}): AgentMentionGroup[] {
  if (input.currentFilter === "issue" && input.issueTopicGroups !== null) {
    return input.issueTopicGroups.map((group) => ({
      id: group.id,
      label: group.label,
      items: group.items,
      totalCount: group.totalCount,
      visibleCount: group.items.length,
      hasMore: group.nextPageToken !== null,
      expandStatus: group.loadMoreStatus
    }));
  }
  const provenanceGroups = buildAgentProvenanceGroups(input);
  if (provenanceGroups) {
    return provenanceGroups;
  }
  const orderedGroupIds = groupIdsForFilter(input.currentFilter);
  return orderedGroupIds
    .map((groupId) => {
      const rawItems = resolveMentionGroupItems(groupId, input.rawGroups);
      const items =
        groupId === "agent_generated_files"
          ? presentAgentGeneratedFileMentionItems({
              files: rawItems,
              browsePath: input.agentGeneratedBrowsePath,
              query: input.currentQuery
            })
          : rawItems;
      if (items.length === 0) {
        if (
          !shouldShowEmptyGroup(
            groupId,
            input.currentFilter,
            input.currentQuery
          )
        ) {
          return null;
        }
        return buildEmptyGroup(groupId, input.currentQuery);
      }
      const pageSize = mentionGroupPageSize(input.currentFilter, groupId);
      const visibleCount =
        groupId === "apps"
          ? items.length
          : Math.min(items.length, input.expandedCounts[groupId] ?? pageSize);
      const totalCount = resolveMentionGroupTotalCount(
        groupId,
        input.totalCounts,
        items.length
      );
      return {
        id: groupId,
        items: items.slice(0, visibleCount),
        totalCount,
        visibleCount,
        hasMore:
          groupId !== "apps" &&
          (items.length > visibleCount ||
            ((groupId === "opened_files" ||
              groupId === "files" ||
              groupId === "agent_generated_files") &&
              items.length >= input.currentFileSearchLimit) ||
            totalCount > visibleCount)
      } satisfies AgentMentionGroup;
    })
    .filter((group): group is AgentMentionGroup => group !== null);
}

export function cloneAgentMentionIssueTopicGroups(
  groups: readonly AgentMentionIssueTopicGroup[] | null
): AgentMentionIssueTopicGroup[] | null {
  return (
    groups?.map((group) => ({ ...group, items: [...group.items] })) ?? null
  );
}

export function issueTopicPaginationChanges(
  groupsAtStart: readonly AgentMentionIssueTopicGroup[] | null,
  currentGroups: readonly AgentMentionIssueTopicGroup[] | null
): AgentMentionIssueTopicGroup[] {
  if (!groupsAtStart || !currentGroups) {
    return [];
  }
  const startingGroups = new Map(
    groupsAtStart.map((group) => [group.id, group] as const)
  );
  return currentGroups.flatMap((group) => {
    const startingGroup = startingGroups.get(group.id);
    if (!startingGroup) {
      return [];
    }
    const startingIssueIds = new Set(
      startingGroup.items
        .filter((item) => item.kind === "workspace-issue")
        .map((item) => item.targetId)
    );
    const appendedItems = group.items.filter(
      (item) =>
        item.kind !== "workspace-issue" || !startingIssueIds.has(item.targetId)
    );
    if (
      appendedItems.length === 0 &&
      group.nextPageToken === startingGroup.nextPageToken
    ) {
      return [];
    }
    return [{ ...group, items: appendedItems }];
  });
}

function buildAgentProvenanceGroups(input: {
  currentFilter: AgentMentionFilterId;
  expandedCounts: Partial<Record<AgentMentionGroupId, number>>;
  provenanceCatalog: ReferenceProvenanceCatalog | null;
  provenanceFilter: ReferenceProvenanceFilter | null;
  rawGroups: AgentMentionRawGroups;
}): AgentMentionGroup[] | null {
  if (
    (input.currentFilter !== "session" && input.currentFilter !== "agent") ||
    !input.provenanceCatalog?.enabledDimensions.includes("agent")
  ) {
    return null;
  }
  const selectedAgentTargetIds = input.provenanceFilter?.agentTargetIds ?? null;
  const selectedAgentTargetIdSet =
    selectedAgentTargetIds === null ? null : new Set(selectedAgentTargetIds);
  const sourceItems = agentProvenanceItemsForFilter(input).filter((item) => {
    if (selectedAgentTargetIdSet === null) {
      return true;
    }
    const agentTargetId = agentTargetIdForMentionItem(item);
    return (
      agentTargetId !== null && selectedAgentTargetIdSet.has(agentTargetId)
    );
  });
  const catalogAgentTargetIds = new Set(
    input.provenanceCatalog.agentOptions.map((option) => option.id)
  );
  const catalogGroups = input.provenanceCatalog.agentOptions.flatMap(
    (option) => {
      const items = sourceItems.filter(
        (item) => agentTargetIdForMentionItem(item) === option.id
      );
      if (items.length === 0) {
        return [];
      }
      return [
        buildAgentProvenanceGroup({
          currentFilter: input.currentFilter,
          expandedCounts: input.expandedCounts,
          id: agentProvenanceMentionGroupId(option.id),
          label: option.label,
          items
        })
      ];
    }
  );
  if (selectedAgentTargetIdSet !== null) {
    return catalogGroups;
  }
  const unmatchedGroups = new Map<
    string,
    {
      id: `agent:${string}`;
      label: string;
      items: AgentProvenanceMentionItem[];
    }
  >();
  for (const item of sourceItems) {
    const agentTargetId = agentTargetIdForMentionItem(item);
    if (agentTargetId && catalogAgentTargetIds.has(agentTargetId)) {
      continue;
    }
    const identity = unmatchedAgentProvenanceIdentity(item);
    const key = `uncatalogued:${identity}`;
    const existing = unmatchedGroups.get(key);
    if (existing) {
      existing.items.push(item);
      continue;
    }
    unmatchedGroups.set(key, {
      id: agentProvenanceMentionGroupId(key),
      label: unmatchedAgentProvenanceLabel(item),
      items: [item]
    });
  }
  return [
    ...catalogGroups,
    ...[...unmatchedGroups.values()].map((group) =>
      buildAgentProvenanceGroup({
        currentFilter: input.currentFilter,
        expandedCounts: input.expandedCounts,
        ...group
      })
    )
  ];
}

function agentProvenanceItemsForFilter(input: {
  currentFilter: AgentMentionFilterId;
  rawGroups: AgentMentionRawGroups;
}): AgentProvenanceMentionItem[] {
  if (input.currentFilter === "session") {
    return input.rawGroups.sessions.filter((item) => item.kind === "session");
  }
  return input.rawGroups.agents.filter((item) => item.kind === "agent-target");
}

function agentTargetIdForMentionItem(
  item: AgentProvenanceMentionItem
): string | null {
  if (item.kind === "session") {
    return item.agentTargetId?.trim() || null;
  }
  if (item.kind === "agent-target") {
    return item.targetId.trim() || null;
  }
  return null;
}

function unmatchedAgentProvenanceIdentity(
  item: AgentProvenanceMentionItem
): string {
  if (item.kind === "session") {
    return (
      item.agentTargetId?.trim() ||
      item.agentName.trim() ||
      item.initiatorName.trim() ||
      item.targetId
    );
  }
  return item.targetId;
}

function unmatchedAgentProvenanceLabel(
  item: AgentProvenanceMentionItem
): string {
  if (item.kind === "session") {
    return (
      item.agentName.trim() ||
      item.initiatorName.trim() ||
      item.agentTargetId?.trim() ||
      item.title
    );
  }
  return item.name;
}

function buildAgentProvenanceGroup(input: {
  currentFilter: AgentMentionFilterId;
  expandedCounts: Partial<Record<AgentMentionGroupId, number>>;
  id: `agent:${string}`;
  label: string;
  items: AgentContextMentionItem[];
}): AgentMentionGroup {
  const pageSize = mentionGroupPageSize(input.currentFilter, input.id);
  const visibleCount = Math.min(
    input.items.length,
    input.expandedCounts[input.id] ?? pageSize
  );
  return {
    id: input.id,
    label: input.label,
    items: input.items.slice(0, visibleCount),
    totalCount: input.items.length,
    visibleCount,
    hasMore: input.items.length > visibleCount
  };
}

export function agentProvenanceMentionGroupId(
  agentTargetId: string
): `agent:${string}` {
  return `agent:${encodeURIComponent(agentTargetId)}`;
}

export function emptyAgentMentionRawGroups(): AgentMentionRawGroups {
  return {
    apps: [],
    agents: [],
    opened_files: [],
    agent_generated_files: [],
    sessions: [],
    issues: []
  };
}

export function cloneAgentMentionRawGroups(
  rawGroups: AgentMentionRawGroups
): AgentMentionRawGroups {
  return {
    apps: [...rawGroups.apps],
    agents: [...rawGroups.agents],
    opened_files: [...rawGroups.opened_files],
    agent_generated_files: [...rawGroups.agent_generated_files],
    sessions: [...rawGroups.sessions],
    issues: [...rawGroups.issues]
  };
}

export function totalCountsFromRawGroups(
  rawGroups: AgentMentionRawGroups
): AgentMentionTotalCounts {
  return {
    apps: rawGroups.apps.length,
    agents: rawGroups.agents.length,
    opened_files: rawGroups.opened_files.length,
    agent_generated_files: rawGroups.agent_generated_files.length,
    my_sessions: rawGroups.sessions.filter(
      (item) => item.kind === "session" && item.scope === "my_sessions"
    ).length,
    collab_sessions: rawGroups.sessions.filter(
      (item) => item.kind === "session" && item.scope === "collab_sessions"
    ).length,
    issues: rawGroups.issues.length
  };
}

export function rawGroupItemCount(rawGroups: AgentMentionRawGroups): number {
  return Object.values(rawGroups).reduce(
    (count, items) => count + items.length,
    0
  );
}

export function providerDiagnosticsSummary(
  diagnostics: readonly AgentMentionProviderQueryDiagnostic[]
): string {
  return diagnostics
    .map(
      (diagnostic) =>
        `${diagnostic.providerId}:${diagnostic.status}:${diagnostic.resultCount}:${diagnostic.durationMs}`
    )
    .join(",");
}

export function elapsedDiagnosticMs(now: number, startedAt: number): number {
  const durationMs = now - startedAt;
  return Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs)) : 0;
}

export function diagnosticErrorKind(error: unknown): string {
  if (error instanceof Error && error.name.trim()) {
    return error.name.trim();
  }
  if (error === null) {
    return "null";
  }
  return typeof error;
}

export function logAgentMentionLifecycleDiagnostic(
  payload: AgentMentionLifecycleDiagnosticLog
): void {
  try {
    console.info(AGENT_MENTION_LIFECYCLE_LOG_PREFIX, JSON.stringify(payload));
  } catch (logError) {
    // Diagnostic logging must never affect mention search state.
    console.error(
      "[agent-gui] logAgentMentionLifecycleDiagnostic console.info failed",
      logError
    );
  }
  try {
    getOptionalAgentHostApi()?.debug?.logRuntimeDiagnostics?.({
      source: "renderer-workspace-surface",
      level: "info",
      event: `agent-gui.mention.${payload.event}`,
      // i18n-check-ignore: Internal diagnostic log message.
      message: "Agent GUI mention search lifecycle event.",
      details: payload.details
    });
  } catch (logError) {
    // Diagnostic logging must never affect mention search state.
    console.error(
      "[agent-gui] logAgentMentionLifecycleDiagnostic host diagnostics failed",
      logError
    );
  }
}

export function normalizeSessionMentionItems(input: {
  items: readonly AgentContextMentionItem[];
}): AgentContextMentionItem[] {
  return input.items.filter((item) => item.kind === "session");
}

export function providerItemToAgentMentionItem(input: {
  currentUserId: string;
  providerId: string;
  insertResult: AgentContextMentionInsertResult;
  label: string;
  subtitle: string;
  workspaceId: string;
}): AgentContextMentionItem | null {
  const label = compactText(input.label);
  if (!label) {
    return null;
  }
  if (input.insertResult.kind === "markdown-link") {
    const href = input.insertResult.href.trim();
    return {
      kind: "file",
      href,
      path: href,
      name: label,
      entryKind: href.endsWith("/") ? "directory" : "unknown",
      directoryPath: dirnameFromProviderWorkspaceFileHref(href)
    };
  }
  if (input.insertResult.kind !== "mention") {
    return null;
  }

  const mention = input.insertResult.mention;
  const targetId = mention.entityId.trim();
  if (!targetId) {
    return null;
  }
  const scope = normalizeMentionScope(mention.scope);
  const presentation = mention.presentation ?? {};
  const workspaceId = scope.workspaceId || input.workspaceId;
  if (
    input.providerId === FILE_PROVIDER_ID ||
    input.providerId === AGENT_GENERATED_FILE_PROVIDER_ID
  ) {
    return {
      kind: "file",
      href: createRichTextMentionHref({
        providerId: input.providerId,
        entityId: targetId,
        label,
        scope
      }),
      path: targetId,
      name: label,
      entryKind: targetId.endsWith("/") ? "directory" : "unknown",
      directoryPath: dirnameFromProviderWorkspaceFileHref(targetId),
      thumbnailUrl: presentation.thumbnailUrl?.trim() || undefined
    };
  }
  if (input.providerId === WORKSPACE_ISSUE_PROVIDER_ID) {
    return {
      kind: "workspace-issue",
      href: createRichTextMentionHref({
        providerId: "workspace-issue",
        entityId: targetId,
        label,
        scope: {
          workspaceId,
          ...(scope.topicId ? { topicId: scope.topicId } : {})
        }
      }),
      workspaceId,
      targetId,
      topicId: scope.topicId,
      name: label,
      title: label,
      status: presentation.status?.trim() || undefined,
      contentPreview:
        compactText(presentation.description) ||
        compactText(input.subtitle) ||
        undefined
    };
  }
  if (input.providerId === WORKSPACE_APP_PROVIDER_ID) {
    const appId = targetId;
    return {
      kind: "workspace-app",
      href: createRichTextMentionHref({
        providerId: "workspace-app",
        entityId: appId,
        label,
        scope: { workspaceId }
      }),
      workspaceId,
      targetId: appId,
      appId,
      name: label,
      description:
        compactText(presentation.description) ||
        compactText(presentation.subtitle) ||
        compactText(input.subtitle) ||
        undefined,
      iconUrl: presentation.iconUrl?.trim() || undefined,
      referencesListSupported: presentation.referencesListSupported === "true"
    };
  }
  if (input.providerId === AGENT_TARGET_PROVIDER_ID) {
    const agentProviderId = presentation.agentProviderId?.trim() || undefined;
    return {
      kind: "agent-target",
      href: createRichTextMentionHref({
        providerId: "agent-target",
        entityId: targetId,
        label,
        scope: { workspaceId }
      }),
      workspaceId,
      targetId,
      name: label,
      description:
        compactText(presentation.description) ||
        compactText(presentation.subtitle) ||
        compactText(input.subtitle) ||
        undefined,
      agentProviderId,
      iconUrl: presentation.iconUrl?.trim() || undefined
    };
  }
  if (input.providerId === AGENT_SESSION_PROVIDER_ID) {
    const agentName = presentation.subtitle?.trim() || "";
    const title = normalizeAgentSessionMentionTitle(label) || label;
    const description = compactText(presentation.description);
    const summaryPreview =
      description || compactText(input.subtitle) || undefined;
    return {
      kind: "session",
      href: createRichTextMentionHref({
        providerId: "agent-session",
        entityId: targetId,
        label,
        scope: {
          workspaceId,
          ...(scope.agentTargetId ? { agentTargetId: scope.agentTargetId } : {})
        }
      }),
      workspaceId,
      targetId,
      name: label,
      title,
      scope: mentionSessionScope({
        currentUserId: input.currentUserId,
        rawScope: scope.scope,
        userId: scope.userId
      }),
      initiatorName: "",
      agentName,
      agentIconUrl:
        presentation.agentIconUrl?.trim() ||
        presentation.iconUrl?.trim() ||
        undefined,
      ...(scope.agentTargetId ? { agentTargetId: scope.agentTargetId } : {}),
      status: presentation.status?.trim() || undefined,
      inputPreview: description || undefined,
      summaryPreview
    };
  }
  return null;
}

export function normalizeMentionScope(
  scope?: Readonly<Record<string, string>>
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(scope ?? {})
      .map(([key, value]) => [key.trim(), value.trim()] as const)
      .filter(([key, value]) => key.length > 0 && value.length > 0)
  );
}

export function mentionSessionScope(input: {
  currentUserId: string;
  rawScope: string | undefined;
  userId?: string;
}): Extract<AgentContextMentionItem, { kind: "session" }>["scope"] {
  const rawScope = input.rawScope?.trim() ?? "";
  if (rawScope === "my_sessions" || rawScope === "collab_sessions") {
    return rawScope;
  }
  const userId = input.userId?.trim() ?? "";
  const currentUserId = input.currentUserId.trim();
  if (
    !userId ||
    !currentUserId ||
    userId === "local" ||
    currentUserId === "local"
  ) {
    return "my_sessions";
  }
  return userId === currentUserId ? "my_sessions" : "collab_sessions";
}

export function dirnameFromProviderWorkspaceFileHref(href: string): string {
  const normalized = href.replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  if (index <= 0) {
    return "/";
  }
  return normalized.slice(0, index);
}
