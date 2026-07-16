import type {
  AgentActivityInteraction,
  AgentActivityTurn,
  AgentSessionEngine
} from "@tutti-os/agent-activity-core";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { AgentActivityRuntime } from "../../../agentActivityRuntime";
import type { AgentPromptContentBlock } from "../../../shared/contracts/dto";
import type { AgentSessionComposerSettings } from "../../../shared/agentSessionTypes";
import type {
  PlanIssueCreationOptions,
  PlanIssueDraft
} from "../../../shared/agentConversation/planImplementationPresentation";
import type { AgentGUINodeData } from "../../../types";
import type { AgentComposerSubmitOptions } from "../composer/AgentComposer.types";
import type { AgentGUIConversationSummary } from "../model/agentGuiConversationModel";
import type {
  AgentComposerDraft,
  SubmittedDraftSnapshot
} from "../model/agentGuiNodeTypes";
import type { useAgentGUIActivation } from "./useAgentGUIActivation";
import type { AgentGUINewConversationActivationResult } from "./agentGuiNewConversationActivation.types";
import type { ConversationIntent } from "./useAgentConversationSelection";

export interface UseAgentGUISubmitInteractionActionsInput {
  activation: ReturnType<typeof useAgentGUIActivation>;
  activeCanonicalComposerSettings: AgentSessionComposerSettings;
  activeConversationIdRef: RefObject<string | null>;
  activeEngineActiveTurn: AgentActivityTurn | null;
  activeEnginePendingInteractions: readonly AgentActivityInteraction[];
  agentActivityRuntime: AgentActivityRuntime;
  conversationListQuery: unknown | null;
  conversationsRef: RefObject<AgentGUIConversationSummary[]>;
  dataRef: RefObject<AgentGUINodeData>;
  draftByScopeKeyRef: RefObject<Record<string, AgentComposerDraft>>;
  draftSettingsBySessionIdRef: RefObject<
    Record<string, AgentSessionComposerSettings>
  >;
  executePromptRef: RefObject<
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
  >;
  isComposerHomeRef: RefObject<boolean>;
  isCurrentConversation(agentSessionId: string): boolean;
  isRespondingToInteraction: boolean;
  isSessionMarkedNonResumable(agentSessionId: string): boolean;
  persistActiveConversation(agentSessionId: string | null): void;
  planActionsRef: RefObject<{
    createIssue(creationOptions?: PlanIssueCreationOptions): void;
    implement(): void;
    orchestrate(draft: PlanIssueDraft, displayPrompt: string): void;
    feedback(value: string): void;
    skip(): void;
  }>;
  previewMode: boolean;
  promptImagesSupported: boolean;
  sessionEngine: AgentSessionEngine;
  setActiveConversationId: Dispatch<SetStateAction<string | null>>;
  setDetailError: Dispatch<SetStateAction<string | null>>;
  setDraftByScopeKey: Dispatch<
    SetStateAction<Record<string, AgentComposerDraft>>
  >;
  setDraftSettingsBySessionId: Dispatch<
    SetStateAction<Record<string, AgentSessionComposerSettings>>
  >;
  setGoalClearNoticeSequence: Dispatch<SetStateAction<number>>;
  setIntent: Dispatch<SetStateAction<ConversationIntent>>;
  submittedDraftSnapshotsRef: RefObject<Record<string, SubmittedDraftSnapshot>>;
  startConversation(
    content: AgentPromptContentBlock[],
    displayPrompt?: string,
    options?: AgentComposerSubmitOptions,
    settingsOverride?: AgentSessionComposerSettings,
    sourceScopeKeyOverride?: string
  ): AgentGUINewConversationActivationResult | null;
  submitPromptRef: RefObject<
    (
      content: AgentPromptContentBlock[],
      displayPrompt?: string,
      options?: AgentComposerSubmitOptions
    ) => void
  >;
  transientConversation: AgentGUIConversationSummary | null;
  workspaceId: string;
}

export function planIssueCreationOptionsFromPayload(
  payload: Record<string, unknown> | undefined
): PlanIssueCreationOptions | undefined {
  const value = payload?.creationOptions;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const executionMode = record.executionMode;
  return typeof record.startExecution === "boolean" &&
    (executionMode === undefined ||
      executionMode === "sequential" ||
      executionMode === "parallel") &&
    record.draft !== null &&
    typeof record.draft === "object" &&
    !Array.isArray(record.draft)
    ? (record as unknown as PlanIssueCreationOptions)
    : undefined;
}

export function planIssueDraftFromPayload(
  payload: Record<string, unknown> | undefined
): PlanIssueDraft | undefined {
  const value = payload?.draft;
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    ((value as Record<string, unknown>).stage === "budget" ||
      (value as Record<string, unknown>).stage === "preview")
    ? (value as PlanIssueDraft)
    : undefined;
}
