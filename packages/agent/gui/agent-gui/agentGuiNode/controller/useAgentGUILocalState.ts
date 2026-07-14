import { useRef, useState } from "react";
import type { AgentHostUserProject } from "../../../host/agentHostApi";
import type { AgentSessionComposerSettings } from "../../../shared/agentSessionTypes";
import type { AgentGUINodeData } from "../../../types";
import type { AgentGUIConversationSummary } from "../model/agentGuiConversationModel";
import type {
  AgentComposerDraft,
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

  return {
    activeConversationId,
    detailError,
    draftByScopeKey,
    draftSettingsBySessionId,
    intent,
    isComposerHome,
    isDeletingConversation,
    isDeletingProjectConversations,
    isLoadingMessages,
    listError,
    pendingDeleteConversation,
    pendingDeleteProjectConversations,
    selectedProjectPath,
    setActiveConversationId,
    setDetailError,
    setDraftByScopeKey,
    setDraftSettingsBySessionId,
    setIntent,
    setIsComposerHome,
    setIsDeletingConversation,
    setIsDeletingProjectConversations,
    setIsLoadingMessages,
    setListError,
    setPendingDeleteConversation,
    setPendingDeleteProjectConversations,
    setSelectedProjectPath,
    setUserProjects,
    submittedDraftSnapshotsRef,
    userProjects
  };
}
