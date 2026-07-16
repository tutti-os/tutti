// Agent GUI controller — shared TypeScript types for the controller hook.

import type { AgentSessionComposerSettings } from "../../../shared/agentSessionTypes";
import type { PlanIssueCreationOptions } from "../../../shared/agentConversation/planImplementationPresentation";
import type {
  AgentGUIAgentTarget,
  AgentGUINodeData,
  AgentGUIProvider,
  AgentGUIProviderRailMode,
  AgentGUIProviderReadinessGate
} from "../../../types";
import type { AgentGUIComposerSettingOption } from "../model/agentGuiNodeTypes";
import type {
  AgentGUIRememberComposerDefaultsInput,
  AgentGUIRememberComposerDefaultsResult
} from "./agentGuiController.providerHelpers";
import type { AgentGUIComposerAppendRequest } from "./useAgentGUIComposerAppendRequest";
import type { AgentGUIPrefillPromptRequest } from "./useAgentGUIConversationHome";
import type { AgentGUIOpenSessionRequest } from "./agentGuiController.draftMessageHelpers";

export type AgentGUIRuntimeErrorPhase =
  | "create_conversation"
  | "interrupt_current_turn"
  | "load_session_state"
  | "retry_activation"
  | "send_prompt"
  | "submit_interactive"
  | "toggle_conversation_pinned"
  | "rename_conversation"
  | "delete_conversation"
  | "update_session_settings"
  | "warmup_openclaw_gateway";

export interface QueuedPromptRetryBlock {
  queuedPromptId: string;
  sessionStateUpdatedAtUnixMs: number | null;
  conversationUpdatedAtUnixMs: number | null;
}

export interface QueuedComposerSettingsUpdate {
  sessionSettingsPatch: AgentSessionComposerSettings;
}

export interface ACPConfigOptionSelection {
  options: AgentGUIComposerSettingOption[];
  currentValue: string | null;
}
export interface UseAgentGUINodeControllerInput {
  nodeId?: string;
  workspaceId: string;
  currentUserId?: string | null;
  workspacePath: string;
  avoidGroupingEdits: boolean;
  data: AgentGUINodeData;
  agentTargets?: readonly AgentGUIAgentTarget[];
  agentTargetsLoading?: boolean;
  handoffAgentTargets?: readonly AgentGUIAgentTarget[];
  handoffAgentTargetsLoading?: boolean;
  providerRailMode?: AgentGUIProviderRailMode;
  comingSoonProviders?: readonly AgentGUIProvider[];
  providerReadinessGates?: Partial<
    Record<AgentGUIProvider, AgentGUIProviderReadinessGate | null>
  > | null;
  defaultAgentTargetId?: string | null;
  composerAppendRequest?: AgentGUIComposerAppendRequest | null;
  openSessionRequest?: AgentGUIOpenSessionRequest | null;
  prefillPromptRequest?: AgentGUIPrefillPromptRequest | null;
  previewMode?: boolean;
  onDataChange: (
    updater: (current: AgentGUINodeData) => AgentGUINodeData
  ) => void;
  onRememberComposerDefaults?: (
    input: AgentGUIRememberComposerDefaultsInput
  ) => void | Promise<AgentGUIRememberComposerDefaultsResult>;
  onCreateIssueFromPlan?: (input: {
    agentSessionId: string;
    creationOptions?: PlanIssueCreationOptions;
    planTurnId: string;
    workspaceId: string;
  }) =>
    | Promise<{ issueId: string; topicId: string }>
    | { issueId: string; topicId: string };
  onShowMessage?: (
    message: string,
    tone?: "info" | "warning" | "error"
  ) => void;
}
