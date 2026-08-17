import {
  selectRootAgentSessionIdsWithPendingInteractions,
  selectWorkspaceAgentConsumerSessions,
  type AgentSessionEngineState
} from "@tutti-os/agent-activity-core";
import { projectCanonicalAgentGUIConversationSummaries } from "../../../shared/agentGUIConversationSummaryProjection";
import { createAgentGUIConversationRailTitlePromptSelector } from "../../../shared/agentConversationRailTitlePromptSelector";
import { selectRootAgentSessionIdsAwaitingPlanImplementation } from "../../../shared/agentConversation/planImplementationAwaiting";
import type { AgentGUIConversationSummary } from "../model/agentGuiConversationModel";
import type { AgentGUIConversationRailQuerySnapshot } from "./agentConversationRailQuerySnapshot";

export function createConversationRailConversationsSelector(): (
  input: {
    engineState: AgentSessionEngineState;
    interactionLocked: boolean;
    querySnapshot: AgentGUIConversationRailQuerySnapshot;
  },
  previous?: readonly AgentGUIConversationSummary[]
) => AgentGUIConversationSummary[] {
  const selectRailTitlePrompts =
    createAgentGUIConversationRailTitlePromptSelector();
  return (input, previous = []) => {
    if (input.interactionLocked && previous.length > 0) {
      return previous as AgentGUIConversationSummary[];
    }
    const workspaceSessions = selectWorkspaceAgentConsumerSessions(
      input.engineState
    );
    const projectionSessionIds = new Set<string>();
    if (!input.querySnapshot.runtimeSectionsEnabled) {
      for (const session of workspaceSessions) {
        projectionSessionIds.add(session.session.agentSessionId);
      }
    }
    for (const section of input.querySnapshot.runtimeRailMemberships ?? []) {
      for (const sessionId of section.sessionIds) {
        projectionSessionIds.add(sessionId);
      }
    }
    for (const sessionId of input.querySnapshot
      .runtimeRailReconcilingSessionIds) {
      projectionSessionIds.add(sessionId);
    }
    for (const sessionId of input.querySnapshot.railSearch.sessionIds) {
      projectionSessionIds.add(sessionId);
    }
    const scopedAgentTargetId = input.querySnapshot.agentTargetId;
    for (const item of workspaceSessions) {
      if (
        item.session.kind === "root" &&
        item.activeTurn?.phase !== undefined &&
        item.activeTurn.phase !== "settled" &&
        (!scopedAgentTargetId ||
          item.session.agentTargetId?.trim() === scopedAgentTargetId)
      ) {
        projectionSessionIds.add(item.session.agentSessionId);
      }
    }
    const rootSessionIdsAwaitingUserAction = new Set([
      ...selectRootAgentSessionIdsWithPendingInteractions(input.engineState),
      ...selectRootAgentSessionIdsAwaitingPlanImplementation(input.engineState)
    ]);
    return stabilizeConversationSectionItems(
      previous,
      projectCanonicalAgentGUIConversationSummaries(
        workspaceSessions.filter((session) =>
          projectionSessionIds.has(session.session.agentSessionId)
        ),
        selectRailTitlePrompts(input.engineState),
        rootSessionIdsAwaitingUserAction
      )
    );
  };
}

function stabilizeConversationSectionItems(
  previous: readonly AgentGUIConversationSummary[],
  next: readonly AgentGUIConversationSummary[]
): AgentGUIConversationSummary[] {
  if (previous.length !== next.length) {
    const previousById = new Map<string, AgentGUIConversationSummary>();
    for (const item of previous) {
      if (!previousById.has(item.id)) previousById.set(item.id, item);
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
  return changed ? stable : (previous as AgentGUIConversationSummary[]);
}

function conversationSummariesRenderEqual(
  left: AgentGUIConversationSummary,
  right: AgentGUIConversationSummary
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
    left.isolation?.mode === right.isolation?.mode &&
    left.railSectionKey === right.railSectionKey &&
    left.pinnedAtUnixMs === right.pinnedAtUnixMs &&
    left.sortTimeUnixMs === right.sortTimeUnixMs &&
    left.updatedAtUnixMs === right.updatedAtUnixMs &&
    left.isTransient === right.isTransient &&
    left.projectionSource === right.projectionSource &&
    left.isImported === right.isImported &&
    left.hasUnreadCompletion === right.hasUnreadCompletion &&
    left.unreadCompletionKey === right.unreadCompletionKey &&
    left.needsUserAction === right.needsUserAction &&
    conversationProjectsRenderEqual(left.project, right.project)
  );
}

function conversationProjectsRenderEqual(
  left: AgentGUIConversationSummary["project"],
  right: AgentGUIConversationSummary["project"]
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
        left.pinnedAtUnixMs === right.pinnedAtUnixMs)
  );
}
