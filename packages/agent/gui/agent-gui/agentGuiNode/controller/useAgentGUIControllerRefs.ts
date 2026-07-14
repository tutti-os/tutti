import type { AgentActivitySnapshot } from "@tutti-os/agent-activity-core";
import { useRef } from "react";
import type { AgentHostUserProject } from "../../../host/agentHostApi";
import type { AgentSessionComposerSettings } from "../../../shared/agentSessionTypes";
import type { AgentPromptContentBlock } from "../../../shared/contracts/dto";
import type { AgentGUINodeData, AgentGUIAgentTarget } from "../../../types";
import type { AgentComposerDraft } from "../model/agentGuiNodeTypes";
import type { AgentGUIConversationSummary } from "../model/agentGuiConversationModel";
import type { AgentGUIComposerTargetData } from "./agentGuiController.composerPresentation";
import type { AgentGUIOpenSessionRequest } from "./agentGuiController.draftMessageHelpers";
import type { AgentGUIRememberComposerDefaultsInput } from "./agentGuiController.providerHelpers";

interface UseAgentGUIControllerRefsInput {
  activeConversationId: string | null;
  agentActivitySnapshot: AgentActivitySnapshot;
  conversations: AgentGUIConversationSummary[];
  data: AgentGUINodeData;
  draftBySessionId: Record<string, AgentComposerDraft>;
  draftSettingsBySessionId: Record<string, AgentSessionComposerSettings>;
  effectiveSelectedProviderTarget: AgentGUIAgentTarget;
  homeComposerTargetOverride: AgentGUIAgentTarget | null;
  isComposerHome: boolean;
  isCreatingConversation: boolean;
  isNoProjectPath: ((input: { path: string }) => boolean) | undefined;
  onDataChange: (
    updater: (current: AgentGUINodeData) => AgentGUINodeData
  ) => void;
  onRememberComposerDefaults:
    | ((input: AgentGUIRememberComposerDefaultsInput) => void | Promise<void>)
    | undefined;
  onShowMessage:
    | ((message: string, tone?: "info" | "warning" | "error") => void)
    | undefined;
  agentTargetsProvided: boolean;
  selectedComposerTargetData: AgentGUIComposerTargetData;
  selectedProjectPath: string | null;
  selectedAgentTargetIsExplicit: boolean;
  userProjects: AgentHostUserProject[];
}

export function useAgentGUIControllerRefs(
  input: UseAgentGUIControllerRefsInput
) {
  const activeConversationIdRef = useRef(input.activeConversationId);
  const selectedProjectPathRef = useRef(input.selectedProjectPath);
  const userProjectsRef = useRef(input.userProjects);
  const isNoProjectPathRef = useRef(input.isNoProjectPath);
  const userProjectsLoadSeqRef = useRef(0);
  const composerOptionsProjectKeyRef = useRef<string | null>(null);
  const conversationsRef = useRef(input.conversations);
  const isMountedRef = useRef(true);
  const agentActivitySnapshotRef = useRef(input.agentActivitySnapshot);
  const dataRef = useRef(input.data);
  const selectedAgentTargetRef = useRef(input.effectiveSelectedProviderTarget);
  const selectedAgentTargetIsExplicitRef = useRef(
    input.homeComposerTargetOverride
      ? true
      : input.selectedAgentTargetIsExplicit
  );
  const agentTargetsProvidedRef = useRef(input.agentTargetsProvided);
  const selectedComposerTargetDataRef = useRef(
    input.selectedComposerTargetData
  );
  const draftBySessionIdRef = useRef(input.draftBySessionId);
  const draftSettingsBySessionIdRef = useRef(input.draftSettingsBySessionId);
  const onDataChangeRef = useRef(input.onDataChange);
  const onRememberComposerDefaultsRef = useRef(
    input.onRememberComposerDefaults
  );
  const onShowMessageRef = useRef(input.onShowMessage);
  const handledPrefillPromptSequenceRef = useRef<number | null>(null);
  const loadDraftComposerOptionsRef = useRef<() => void>(() => {});
  const lastActiveModelByProviderRef = useRef<Record<string, string>>({});
  const conversationIdsRef = useRef(
    new Set(input.conversations.map((conversation) => conversation.id))
  );
  const lastRenderStateDiagnosticKeyRef = useRef<string | null>(null);
  const handledOpenSessionSequenceRef = useRef<number | null>(null);
  const pendingOpenSessionRequestRef =
    useRef<AgentGUIOpenSessionRequest | null>(null);
  const executePromptRef = useRef<
    (
      agentSessionId: string,
      content: AgentPromptContentBlock[],
      displayPrompt?: string,
      options?: { immediate?: boolean; sendNow?: boolean }
    ) => void
  >(() => {});
  const submitPromptRef = useRef<
    (content: AgentPromptContentBlock[], displayPrompt?: string) => void
  >(() => {});
  const reloadSelectedConversationRef = useRef<
    (
      agentSessionId: string,
      options: { reloadConversations: boolean; reloadDetail: boolean }
    ) => void
  >(() => {});
  const syncConversationListProjectionRef = useRef<
    (agentSessionId?: string | null) => Promise<void>
  >(async () => {});
  const isComposerHomeRef = useRef(input.isComposerHome);
  const isCreatingConversationRef = useRef(input.isCreatingConversation);

  activeConversationIdRef.current = input.activeConversationId;
  selectedProjectPathRef.current = input.selectedProjectPath;
  userProjectsRef.current = input.userProjects;
  isNoProjectPathRef.current = input.isNoProjectPath;
  conversationsRef.current = input.conversations;
  agentActivitySnapshotRef.current = input.agentActivitySnapshot;
  dataRef.current = input.data;
  selectedAgentTargetRef.current = input.effectiveSelectedProviderTarget;
  selectedAgentTargetIsExplicitRef.current = input.homeComposerTargetOverride
    ? true
    : input.selectedAgentTargetIsExplicit;
  agentTargetsProvidedRef.current = input.agentTargetsProvided;
  selectedComposerTargetDataRef.current = input.selectedComposerTargetData;
  draftBySessionIdRef.current = input.draftBySessionId;
  draftSettingsBySessionIdRef.current = input.draftSettingsBySessionId;
  onDataChangeRef.current = input.onDataChange;
  onRememberComposerDefaultsRef.current = input.onRememberComposerDefaults;
  onShowMessageRef.current = input.onShowMessage;
  isComposerHomeRef.current = input.isComposerHome;
  isCreatingConversationRef.current = input.isCreatingConversation;
  conversationIdsRef.current = new Set(
    input.conversations.map((conversation) => conversation.id)
  );

  return {
    activeConversationIdRef,
    agentActivitySnapshotRef,
    composerOptionsProjectKeyRef,
    conversationIdsRef,
    conversationsRef,
    dataRef,
    draftBySessionIdRef,
    draftSettingsBySessionIdRef,
    executePromptRef,
    handledOpenSessionSequenceRef,
    handledPrefillPromptSequenceRef,
    isComposerHomeRef,
    isCreatingConversationRef,
    isMountedRef,
    isNoProjectPathRef,
    lastActiveModelByProviderRef,
    lastRenderStateDiagnosticKeyRef,
    loadDraftComposerOptionsRef,
    onDataChangeRef,
    onRememberComposerDefaultsRef,
    onShowMessageRef,
    pendingOpenSessionRequestRef,
    agentTargetsProvidedRef,
    reloadSelectedConversationRef,
    selectedComposerTargetDataRef,
    selectedProjectPathRef,
    selectedAgentTargetIsExplicitRef,
    selectedAgentTargetRef,
    submitPromptRef,
    syncConversationListProjectionRef,
    userProjectsLoadSeqRef,
    userProjectsRef
  };
}
