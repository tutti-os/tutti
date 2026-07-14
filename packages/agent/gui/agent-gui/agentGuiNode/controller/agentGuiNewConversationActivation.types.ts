import {
  type AgentSessionEngine,
  type PendingActivationIntentRecord
} from "@tutti-os/agent-activity-core";
import { type Dispatch, type RefObject, type SetStateAction } from "react";
import type { AgentActivityRuntime } from "../../../agentActivityRuntime";
import { type AgentGUIConversationListQuery } from "../../../contexts/workspace/presentation/renderer/agentGuiConversationList/useAgentGuiConversationList";
import type {
  AgentSessionComposerSettings,
  AgentSessionState
} from "../../../shared/agentSessionTypes";
import type { AgentGUINodeData, AgentGUIAgentTarget } from "../../../types";
import { type AgentGUIConversationSummary } from "../model/agentGuiConversationModel";
import type {
  AgentComposerDraft,
  SubmittedDraftSnapshot
} from "../model/agentGuiNodeTypes";
import { type AgentGUIComposerTargetData } from "./agentGuiController.composerPresentation";
import type { useAgentGUIActivation } from "./useAgentGUIActivation";

export interface UseAgentGUINewConversationActivationInput {
  getCachedComposerOptions: () =>
    | import("@tutti-os/agent-activity-core").AgentActivityComposerOptions
    | null;
  selectedAgentTargetRef: RefObject<AgentGUIAgentTarget>;
  selectedComposerTargetDataRef: RefObject<AgentGUIComposerTargetData>;
  latestPendingNewActivation: PendingActivationIntentRecord | null;
  agentTargetsProvidedRef: RefObject<boolean>;
  selectedAgentTargetIsExplicitRef: RefObject<boolean>;
  setDetailError: Dispatch<SetStateAction<string | null>>;
  isCreatingConversationRef: RefObject<boolean>;
  onDataChangeRef: RefObject<
    (updater: (current: AgentGUINodeData) => AgentGUINodeData) => void
  >;
  selectedProjectPathRef: RefObject<string | null>;
  draftByScopeKeyRef: RefObject<Record<string, AgentComposerDraft>>;
  submittedDraftSnapshotsRef: RefObject<Record<string, SubmittedDraftSnapshot>>;
  draftSettingsBySessionIdRef: RefObject<
    Record<string, AgentSessionComposerSettings>
  >;
  agentActivityRuntime: AgentActivityRuntime;
  workspaceId: string;
  activeConversationIdRef: RefObject<string | null>;
  conversationsRef: RefObject<AgentGUIConversationSummary[]>;
  activeSessionState: AgentSessionState | null;
  lastActiveModelByProviderRef: RefObject<Record<string, string>>;
  sessionEngine: AgentSessionEngine;
  conversationListQuery: AgentGUIConversationListQuery | null;
  currentUserId: string | null | undefined;
  persistActiveConversation: (agentSessionId: string | null) => void;
  activation: ReturnType<typeof useAgentGUIActivation>;
  isCurrentConversation: (agentSessionId: string) => boolean;
  isConversationStale: (agentSessionId: string) => boolean;
  loadSelectedConversationMessages: (agentSessionId: string) => Promise<void>;
  loadSessionState: (
    agentSessionId: string,
    cause?: { source: string; eventType?: string; force?: boolean }
  ) => void;
  syncConversationListProjection: (
    _preferredSessionId?: string | null
  ) => Promise<void>;
  data: AgentGUINodeData;
  defaultReasoningEffort: string;
  refreshMessagesFromSnapshot: (agentSessionId: string) => void;
}
