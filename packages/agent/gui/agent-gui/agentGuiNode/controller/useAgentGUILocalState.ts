import { useCallback, useRef, useState } from "react";
import type { AgentHostUserProject } from "../../../host/agentHostApi";
import type { AgentSessionComposerSettings } from "../../../shared/agentSessionTypes";
import type { AgentGUINodeData } from "../../../types";
import type { AgentGUIConversationSummary } from "../model/agentGuiConversationModel";
import type {
  AgentGUIConversationRailRevealReason,
  AgentGUIConversationRailRevealRequest
} from "../model/agentGuiConversationRailViewState";
import type {
  AgentComposerDraft,
  AgentGUIOptimisticGoalControl,
  AgentGUIProjectConversationDeleteTarget,
  SubmittedDraftSnapshot
} from "../model/agentGuiNodeTypes";
import { readAgentGUIUserProjectSnapshot } from "./agentGuiController.interactiveHelpers";
import type { ConversationIntent } from "./useAgentConversationSelection";

interface UseAgentGUILocalStateInput {
  data: AgentGUINodeData;
  userProjectsApi: Parameters<typeof readAgentGUIUserProjectSnapshot>[0];
}

export function useAgentGUILocalState({
  data,
  userProjectsApi
}: UseAgentGUILocalStateInput) {
  const [userProjects, setUserProjects] = useState<AgentHostUserProject[]>(() =>
    readAgentGUIUserProjectSnapshot(userProjectsApi)
  );
  const [activeConversationId, setActiveConversationId] = useState<
    string | null
  >(data.lastActiveAgentSessionId);
  const [intent, setIntent] = useState<ConversationIntent>(() =>
    data.lastActiveAgentSessionId
      ? { tag: "requested", id: data.lastActiveAgentSessionId }
      : { tag: "home" }
  );
  const [selectedProjectPath, setSelectedProjectPath] = useState<string | null>(
    null
  );
  const [isComposerHome, setIsComposerHome] = useState(
    data.lastActiveAgentSessionId === null
  );
  const [draftByScopeKey, setDraftByScopeKey] = useState<
    Record<string, AgentComposerDraft>
  >({});
  const submittedDraftSnapshotsRef = useRef<
    Record<string, SubmittedDraftSnapshot>
  >({});
  const [draftSettingsBySessionId, setDraftSettingsBySessionId] = useState<
    Record<string, AgentSessionComposerSettings>
  >({});
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);
  const [isDeletingConversation, setIsDeletingConversation] = useState(false);
  const [isDeletingProjectConversations, setIsDeletingProjectConversations] =
    useState(false);
  const [pendingDeleteConversation, setPendingDeleteConversation] =
    useState<AgentGUIConversationSummary | null>(null);
  const [
    pendingDeleteProjectConversations,
    setPendingDeleteProjectConversations
  ] = useState<AgentGUIProjectConversationDeleteTarget | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [goalClearNoticeSequence, setGoalClearNoticeSequence] = useState(0);
  const [optimisticGoalControl, setOptimisticGoalControl] =
    useState<AgentGUIOptimisticGoalControl | null>(null);
  const railRevealRevisionRef = useRef(0);
  const [railRevealRequest, setRailRevealRequest] =
    useState<AgentGUIConversationRailRevealRequest | null>(null);
  const clearRailRevealRequest = useCallback(() => {
    setRailRevealRequest(null);
  }, []);
  const requestRailReveal = useCallback(
    (agentSessionId: string, reason: AgentGUIConversationRailRevealReason) => {
      const normalized = agentSessionId.trim();
      if (!normalized) return;
      setRailRevealRequest({
        agentSessionId: normalized,
        reason,
        revision: ++railRevealRevisionRef.current
      });
    },
    []
  );

  return {
    activeConversationId,
    clearRailRevealRequest,
    detailError,
    draftByScopeKey,
    draftSettingsBySessionId,
    goalClearNoticeSequence,
    intent,
    isComposerHome,
    isDeletingConversation,
    isDeletingProjectConversations,
    isLoadingMessages,
    listError,
    optimisticGoalControl,
    pendingDeleteConversation,
    pendingDeleteProjectConversations,
    railRevealRequest,
    requestRailReveal,
    selectedProjectPath,
    setActiveConversationId,
    setDetailError,
    setDraftByScopeKey,
    setDraftSettingsBySessionId,
    setGoalClearNoticeSequence,
    setIntent,
    setIsComposerHome,
    setIsDeletingConversation,
    setIsDeletingProjectConversations,
    setIsLoadingMessages,
    setListError,
    setOptimisticGoalControl,
    setPendingDeleteConversation,
    setPendingDeleteProjectConversations,
    setSelectedProjectPath,
    setUserProjects,
    submittedDraftSnapshotsRef,
    userProjects
  };
}
