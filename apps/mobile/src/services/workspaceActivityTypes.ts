import type {
  AgentActivityComposerOptions,
  AgentActivityComposerOptionsLoadStatus,
  AgentActivityInteraction,
  AgentActivitySession,
  AgentActivitySessionSettings,
  AgentActivitySnapshot
} from "@tutti-os/agent-activity-core";
import type { AgentConversationVM } from "@tutti-os/agent-gui/conversation-projection";
import type { AgentGUIConversationActivityCandidate } from "@tutti-os/agent-gui/conversation-activity-projection";
import type { AgentConversationRailSummary } from "@tutti-os/agent-gui/conversation-rail-projection";
import type { AgentComposerSettingsSupport } from "@tutti-os/agent-gui/composer-projection";
import type { AgentTarget, UserProject } from "@tutti-os/client-tuttid-ts";
import type { WorkspaceConversationRailSection } from "./workspaceConversationRailProjection";

export type WorkspaceActivityConversation = AgentConversationRailSummary &
  Pick<AgentGUIConversationActivityCandidate, "hasUnreadCompletion"> & {
    project: UserProject | null;
  };

export interface WorkspaceActivitySearchSnapshot {
  failed: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  pending: boolean;
  query: string;
  resolvedQuery: string;
  sessionIds: readonly string[];
}

export interface WorkspaceActivitySnapshot {
  activity: AgentActivitySnapshot;
  activityConversations: readonly WorkspaceActivityConversation[];
  ambiguousSubmission: boolean;
  composerOptions: AgentActivityComposerOptions | null;
  composerOptionsLoadStatus: AgentActivityComposerOptionsLoadStatus | null;
  composerSettings: AgentActivitySessionSettings;
  composerSettingsSupport: AgentComposerSettingsSupport;
  commandsAvailable: boolean;
  conversation: AgentConversationVM | null;
  creating: boolean;
  draft: string;
  errorCode: "request_failed" | null;
  loading: boolean;
  interactionStates: Readonly<
    Record<
      string,
      {
        failed: boolean;
        submitting: boolean;
        runtimeAvailable: boolean;
      }
    >
  >;
  pendingInteractions: readonly AgentActivityInteraction[];
  pinningSessionIds: readonly string[];
  railErrorCode: "request_failed" | null;
  railSections: readonly WorkspaceConversationRailSection[];
  railStatus: "idle" | "loading" | "ready";
  search: WorkspaceActivitySearchSnapshot;
  selectedAgentSessionId: string | null;
  selectedAgentTargetId: string | null;
  selectedProjectPath: string | null;
  selectedSession: AgentActivitySession | null;
  sending: boolean;
  targets: readonly AgentTarget[];
  userProjectErrorCode: "request_failed" | null;
  userProjects: readonly UserProject[];
  userProjectsStatus: "idle" | "loading" | "ready";
}
