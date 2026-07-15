import type { AgentActivityMessage } from "@tutti-os/agent-activity-core";
import type { AgentHostUserInfo } from "./contracts/dto";
import type { WorkspaceAgentToolCallDisplay } from "./workspaceAgentToolCallDisplay";
import type {
  WorkspaceAgentConversationPreviewLine,
  WorkspaceAgentLatestActivityStatus
} from "./workspaceAgentLatestActivitySummary";

export type WorkspaceAgentActivityStatus = WorkspaceAgentLatestActivityStatus;

export interface WorkspaceAgentChangedFile {
  path: string;
  label: string;
}

export interface WorkspaceAgentActivityCard {
  id: string;
  sessionId: string;
  userId: string | null;
  userName: string;
  userAvatarUrl?: string;
  agentProvider: string;
  agentName: string;
  title: string;
  status: WorkspaceAgentActivityStatus;
  latestActivitySummary: string;
  /** User prompt + latest agent reply for task/issue execution cards; room status list uses single-line summary only. */
  conversationPreview?: WorkspaceAgentConversationPreviewLine[];
  latestActivityActorName?: string;
  toolCalls?: WorkspaceAgentToolCallDisplay[];
  changedFiles: WorkspaceAgentChangedFile[];
  sortTimeUnixMs: number;
  readTimeUnixMs?: number;
}

export interface WorkspaceAgentActivityListViewModel {
  activities: WorkspaceAgentActivityCard[];
}

export interface BuildWorkspaceAgentActivityListOptions {
  sessionMessagesById?: Record<string, AgentActivityMessage[]>;
  userProfilesById?: Record<string, AgentHostUserInfo>;
}

export interface CollectWorkspaceAgentGeneratedFilesOptions {
  /** When set, only include files produced by these Agent targets. */
  agentTargetIds?: readonly string[] | null;
  workspaceRoot?: string | null;
  /** When set, only include files from sessions whose cwd matches this path. */
  sessionCwd?: string | null;
}
import type { AgentActivitySnapshot } from "@tutti-os/agent-activity-core";

export type WorkspaceAgentActivityListSnapshot = Pick<
  AgentActivitySnapshot,
  "presences" | "sessions"
>;
