import type { AgentActivitySnapshot } from "@tutti-os/agent-activity-core";
import { useRef } from "react";
import type { AgentHostUserProject } from "../../../host/agentHostApi";
import type { AgentSessionComposerSettings } from "../../../shared/agentSessionTypes";
import type { AgentPromptContentBlock } from "../../../shared/contracts/dto";
import type { AgentGUINodeData, AgentGUIAgentTarget } from "../../../types";
import type { AgentComposerDraft } from "../model/agentGuiNodeTypes";
import type { AgentComposerSubmitOptions } from "../composer/AgentComposer.types";
import type { AgentGUIConversationSummary } from "../model/agentGuiConversationModel";
import type { AgentGUIComposerTargetData } from "./agentGuiController.composerPresentation";
import type { AgentGUIOpenSessionRequest } from "./agentGuiController.draftMessageHelpers";
import type {
  AgentGUIRememberComposerDefaultsInput,
  AgentGUIRememberComposerDefaultsResult
} from "./agentGuiController.providerHelpers";
import type { AgentGUIComposerDefaultsAuthorityReconciler } from "./agentGuiComposerDefaultsReconciliation";

interface UseAgentGUIControllerRefsInput {
  activeConversationId: string | null;
  agentActivitySnapshot: AgentActivitySnapshot;
  conversations: AgentGUIConversationSummary[];
  data: AgentGUINodeData;
  draftByScopeKey: Record<string, AgentComposerDraft>;
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
    | ((
        input: AgentGUIRememberComposerDefaultsInput
      ) => void | Promise<AgentGUIRememberComposerDefaultsResult>)
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
  const draftByScopeKeyRef = useRef(input.draftByScopeKey);
  const draftSettingsBySessionIdRef = useRef(input.draftSettingsBySessionId);
  const onDataChangeRef = useRef(input.onDataChange);
  const onRememberComposerDefaultsRef = useRef(
    input.onRememberComposerDefaults
  );
  const onShowMessageRef = useRef(input.onShowMessage);
  const handledPrefillPromptSequenceRef = useRef<number | null>(null);
  const handledComposerAppendSequenceRef = useRef<number | null>(null);
  const loadDraftComposerOptionsRef = useRef<() => void>(() => {});
  const onComposerDefaultsAuthorityReloadedRef =
    useRef<AgentGUIComposerDefaultsAuthorityReconciler>({
      prepareRead: (_target, settings) => ({
        force: false,
        receipt: null,
        settings
      }),
      reloaded: () => {}
    });
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
      options?: {
        immediate?: boolean;
        requiredSettingsPatch?: AgentComposerSubmitOptions["requiredSettingsPatch"];
        sendNow?: boolean;
        sourceScopeKey?: string;
        trackDraft?: boolean;
      }
    ) => void
  >(() => {});
  const submitPromptRef = useRef<
    (
      content: AgentPromptContentBlock[],
      displayPrompt?: string,
      options?: AgentComposerSubmitOptions
    ) => void
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
  draftByScopeKeyRef.current = input.draftByScopeKey;
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
    conversationIdsRef,
    conversationsRef,
    dataRef,
    draftByScopeKeyRef,
    draftSettingsBySessionIdRef,
    executePromptRef,
    handledComposerAppendSequenceRef,
    handledOpenSessionSequenceRef,
    handledPrefillPromptSequenceRef,
    isComposerHomeRef,
    isCreatingConversationRef,
    isMountedRef,
    isNoProjectPathRef,
    lastRenderStateDiagnosticKeyRef,
    loadDraftComposerOptionsRef,
    onDataChangeRef,
    onComposerDefaultsAuthorityReloadedRef,
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
