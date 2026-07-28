import {
  canonicalInteractionKey,
  selectRootAgentActivitySessions,
  selectRootAgentSessionIdsWithPendingInteractions,
  selectEngineTurnsForSession,
  selectEngineInteractionResponse,
  selectEngineSessionRuntimeAvailability,
  selectComposerOptions,
  selectComposerOptionsLoadStatus,
  type AgentActivitySessionSettings,
  selectSessionMutations,
  selectWorkspaceAgentRootConversationSessions,
  type AgentActivitySnapshot,
  type AgentSessionEngine
} from "@tutti-os/agent-activity-core";
import {
  composerSettingsSupportFromOptions,
  resolvePresentedAgentComposerSettings
} from "@tutti-os/agent-gui/composer-projection";
import { projectCanonicalAgentGUIConversationSummariesFromState } from "@tutti-os/agent-gui/conversation-rail-projection";
import {
  projectAgentActivitySessionToConversationVM,
  reconcileProjectedAgentConversationVM,
  type AgentConversationVM
} from "@tutti-os/agent-gui/conversation-projection";
import type { AgentTarget } from "@tutti-os/client-tuttid-ts";
import { projectWorkspaceConversationRail } from "./workspaceConversationRailProjection";
import type { WorkspaceConversationRailSnapshot } from "./workspaceConversationRailService";
import type { WorkspaceActivitySnapshot } from "./workspaceActivityTypes";
import type { WorkspaceNavigationSnapshot } from "./workspaceNavigationService";

export interface WorkspaceComposerTarget {
  agentSessionId: string | null;
  agentTargetId: string;
  cwd: string | null;
  provider: string;
  settings: AgentActivitySessionSettings;
}

export function resolveWorkspaceComposerTarget({
  activity,
  getDraftSettings,
  navigation,
  targets
}: {
  activity: AgentActivitySnapshot;
  getDraftSettings(agentTargetId: string): AgentActivitySessionSettings;
  navigation: WorkspaceNavigationSnapshot;
  targets: readonly AgentTarget[];
}): WorkspaceComposerTarget | null {
  if (navigation.creating) {
    const target =
      targets.find(
        (candidate) => candidate.id === navigation.selectedAgentTargetId
      ) ?? null;
    return target
      ? {
          agentSessionId: null,
          agentTargetId: target.id,
          cwd: null,
          provider: target.provider,
          settings: getDraftSettings(target.id)
        }
      : null;
  }
  const session =
    activity.sessions.find(
      (candidate) =>
        candidate.agentSessionId === navigation.selectedAgentSessionId
    ) ?? null;
  return session?.agentTargetId
    ? {
        agentSessionId: session.agentSessionId,
        agentTargetId: session.agentTargetId,
        cwd: session.cwd,
        provider: session.provider,
        settings: session.settings
      }
    : null;
}

export function projectWorkspaceActivitySnapshot({
  activity,
  ambiguousSubmission,
  draftSettings,
  draft,
  errorCode,
  loading,
  navigation,
  previousConversation,
  rail,
  state,
  targets,
  workspaceId
}: {
  activity: AgentActivitySnapshot;
  ambiguousSubmission: boolean;
  draftSettings: AgentActivitySessionSettings;
  draft: string;
  errorCode: "request_failed" | null;
  loading: boolean;
  navigation: WorkspaceNavigationSnapshot;
  previousConversation: AgentConversationVM | null;
  rail: WorkspaceConversationRailSnapshot;
  state: ReturnType<AgentSessionEngine["getSnapshot"]>;
  targets: readonly AgentTarget[];
  workspaceId: string;
}): WorkspaceActivitySnapshot {
  const sessions = selectRootAgentActivitySessions(activity).filter(
    (session) => session.visible
  );
  const selectedSession =
    sessions.find(
      (session) => session.agentSessionId === navigation.selectedAgentSessionId
    ) ?? null;
  const selectedConversation =
    selectWorkspaceAgentRootConversationSessions(state).find(
      (consumer) =>
        consumer.session.agentSessionId === navigation.selectedAgentSessionId
    ) ?? null;
  const pendingInteractions = selectedConversation?.pendingInteractions ?? [];
  const interactionStates = Object.fromEntries(
    pendingInteractions.map((interaction) => {
      const response = selectEngineInteractionResponse(
        state,
        interaction.agentSessionId,
        interaction.turnId,
        interaction.requestId
      );
      const runtimeAvailability = selectEngineSessionRuntimeAvailability(
        state,
        interaction.agentSessionId
      );
      return [
        canonicalInteractionKey(
          interaction.agentSessionId,
          interaction.turnId,
          interaction.requestId
        ),
        {
          failed: response?.status === "failed",
          runtimeAvailable: runtimeAvailability?.state !== "blocked",
          submitting:
            response?.status === "responding" || response?.status === "unknown"
        }
      ];
    })
  );
  const sending =
    Object.values(state.pendingIntents.submitsByClientSubmitId).some(
      (record) =>
        record.agentSessionId === navigation.selectedAgentSessionId &&
        (record.status === "requested" || record.status === "accepted")
    ) ||
    Object.values(state.pendingIntents.activationsByRequestId).some(
      (record) =>
        (navigation.creating ||
          record.agentSessionId === navigation.selectedAgentSessionId) &&
        record.status === "requested" &&
        !sessions.some(
          (session) => session.agentSessionId === record.agentSessionId
        )
    );
  const pinningSessionIds = selectSessionMutations(state).flatMap((mutation) =>
    mutation.kind === "pin" && mutation.status === "inFlight"
      ? mutation.agentSessionIds
      : []
  );
  const composerTarget = navigation.creating
    ? (targets.find(
        (target) => target.id === navigation.selectedAgentTargetId
      ) ?? null)
    : null;
  const composerTargetId = navigation.creating
    ? (composerTarget?.id ?? null)
    : (selectedSession?.agentTargetId ?? null);
  const composerOptions = composerTargetId
    ? selectComposerOptions(state, composerTargetId)
    : null;
  const composerOptionsLoadStatus = composerTargetId
    ? (selectComposerOptionsLoadStatus(state, composerTargetId) ?? null)
    : null;
  const composerSettings = resolvePresentedAgentComposerSettings({
    composerOptions,
    session: selectedSession,
    ...(navigation.creating && composerTargetId
      ? { settings: draftSettings }
      : {})
  });
  const composerSettingsSupport = composerSettingsSupportFromOptions(
    composerOptions,
    selectedSession?.capabilities ?? null
  );
  const projectedConversation = selectedSession
    ? projectAgentActivitySessionToConversationVM({
        activitySnapshot: activity,
        agentSessionId: selectedSession.agentSessionId,
        sessionTurns: selectEngineTurnsForSession(
          state,
          selectedSession.agentSessionId
        )
      })
    : null;
  const conversation =
    projectedConversation &&
    previousConversation?.sourceDetail.session.agentSessionId ===
      selectedSession?.agentSessionId
      ? reconcileProjectedAgentConversationVM(
          previousConversation,
          projectedConversation
        )
      : projectedConversation;
  const conversations = projectCanonicalAgentGUIConversationSummariesFromState(
    state,
    {
      rootSessionIdsAwaitingUserAction: new Set(
        selectRootAgentSessionIdsWithPendingInteractions(state)
      ),
      workspaceId
    }
  );
  const selectedRuntimeAvailability = selectEngineSessionRuntimeAvailability(
    state,
    navigation.selectedAgentSessionId
  );
  const commandsAvailable = navigation.creating
    ? state.engineRuntime.connection === "connected"
    : Boolean(
        selectedSession && selectedRuntimeAvailability?.state !== "blocked"
      );

  return {
    activity,
    ambiguousSubmission,
    composerOptions,
    composerOptionsLoadStatus,
    composerSettings,
    composerSettingsSupport,
    commandsAvailable,
    conversation,
    creating: navigation.creating,
    draft,
    errorCode: errorCode ?? rail.errorCode,
    interactionStates,
    loading,
    pendingInteractions,
    pinningSessionIds,
    railErrorCode: rail.errorCode,
    railSections: projectWorkspaceConversationRail({
      conversations,
      loadingMoreSectionId: rail.loadingMoreSectionId,
      memberships: rail.sections
    }),
    railStatus: rail.status,
    selectedAgentSessionId: navigation.selectedAgentSessionId,
    selectedAgentTargetId: navigation.selectedAgentTargetId,
    selectedSession,
    sending,
    targets
  };
}
