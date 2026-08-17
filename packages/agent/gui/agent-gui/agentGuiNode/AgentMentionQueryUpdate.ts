import { normalizeQuery } from "./agentMentionSearchHelpers";
import type { AgentMentionFilterId } from "./AgentMentionSearchContracts";

interface CurrentMentionQueryContext {
  agentGeneratedBrowsePath: string | null;
  currentUserId: string;
  directoryDepth: number;
  filter: AgentMentionFilterId;
  query: string;
  sectionKey: string;
  sessionCwd: string;
  workspaceId: string;
}

interface MentionQueryInput {
  currentUserId?: string | null;
  query: string;
  sectionKey?: string | null;
  sessionCwd?: string | null;
  workspaceId: string;
}

export function resolveAgentMentionQueryUpdate(
  input: MentionQueryInput,
  current: CurrentMentionQueryContext
) {
  const next = {
    currentUserId: input.currentUserId?.trim() ?? "",
    query: normalizeQuery(input.query),
    sectionKey: input.sectionKey?.trim() ?? "",
    sessionCwd: input.sessionCwd?.trim() ?? "",
    workspaceId: input.workspaceId.trim()
  };
  return {
    ...next,
    ignore:
      !next.query &&
      !current.query &&
      current.filter === "file" &&
      (current.directoryDepth > 0 ||
        current.agentGeneratedBrowsePath !== null) &&
      next.workspaceId === current.workspaceId &&
      next.currentUserId === current.currentUserId &&
      next.sectionKey === current.sectionKey &&
      next.sessionCwd === current.sessionCwd
  };
}
