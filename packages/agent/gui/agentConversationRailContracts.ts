import type { AgentActivitySession } from "@tutti-os/agent-activity-core";

export interface AgentConversationRailUserProject {
  createdAtUnixMs: number;
  id: string;
  label: string;
  lastUsedAtUnixMs?: number;
  path: string;
  pinnedAtUnixMs: number;
  sectionKey: string;
  updatedAtUnixMs: number;
}

export interface AgentConversationRailSessionPage {
  hasMore: boolean;
  nextCursor?: string;
  sessions: AgentActivitySession[];
  totalCount: number;
}

export interface AgentConversationRailSessionSection extends AgentConversationRailSessionPage {
  kind: "conversations" | "project";
  sectionKey: string;
  userProject?: AgentConversationRailUserProject;
}

export interface AgentConversationRailSessionSectionsResult {
  pinned?: AgentConversationRailSessionPage;
  sections: AgentConversationRailSessionSection[];
  workspaceId: string;
}

export interface AgentConversationRailListSessionsPageInput {
  agentTargetId?: string | null;
  cursor?: string;
  limit?: number;
  searchQuery?: string;
  signal?: AbortSignal;
  workspaceId: string;
}

export interface AgentConversationRailSessionsPageResult {
  hasMore: boolean;
  nextCursor?: string;
  sessions: AgentActivitySession[];
  workspaceId: string;
}

export interface AgentConversationRailListSessionSectionsInput {
  agentTargetId?: string | null;
  limitPerSection?: number;
  signal?: AbortSignal;
  workspaceId: string;
}

export interface AgentConversationRailListSessionSectionPageInput {
  agentTargetId?: string | null;
  cursor?: string;
  limit?: number;
  sectionKey: string;
  signal?: AbortSignal;
  workspaceId: string;
}

export type AgentConversationRailListPinnedSessionsPageInput = Omit<
  AgentConversationRailListSessionSectionPageInput,
  "sectionKey"
>;

export interface AgentConversationRailSessionSectionScopeInput {
  agentTargetId?: string | null;
  excludePinned?: boolean;
  sectionKey: string;
  signal?: AbortSignal;
  workspaceId: string;
}

export interface AgentConversationRailSessionSectionDeletionCandidates {
  agentTargetId?: string | null;
  excludePinned: boolean;
  sectionKey: string;
  sessionIds: string[];
  workspaceId: string;
}

export interface AgentConversationRailDeleteSessionsBatchInput {
  sessionIds: string[];
  signal?: AbortSignal;
  workspaceId: string;
}

export interface AgentConversationRailDeleteSessionsBatchResult {
  cleanupFailedSessionIds: string[];
  removedMessages: number;
  removedSessionIds: string[];
  removedSessions: number;
}

export interface AgentConversationRailRuntimePort {
  deleteSessionsBatch?(
    input: AgentConversationRailDeleteSessionsBatchInput
  ): Promise<AgentConversationRailDeleteSessionsBatchResult>;
  listPinnedSessionsPage?(
    input: AgentConversationRailListPinnedSessionsPageInput
  ): Promise<AgentConversationRailSessionPage>;
  listSessionSectionDeletionCandidates?(
    input: AgentConversationRailSessionSectionScopeInput
  ): Promise<AgentConversationRailSessionSectionDeletionCandidates>;
  listSessionSectionPage?(
    input: AgentConversationRailListSessionSectionPageInput
  ): Promise<AgentConversationRailSessionSection>;
  listSessionSections?(
    input: AgentConversationRailListSessionSectionsInput
  ): Promise<AgentConversationRailSessionSectionsResult>;
  listSessionsPage?(
    input: AgentConversationRailListSessionsPageInput
  ): Promise<AgentConversationRailSessionsPageResult>;
  reportDiagnostic?(input: {
    details?: Record<string, unknown>;
    event: string;
    level?: "debug" | "info" | "warn" | "error";
    source?: string;
    workspaceId?: string | null;
  }): Promise<void> | void;
}
