// Standalone conversation-flow rendering, decoupled from the full AgentGUI node.
//
// Render a single agent session's transcript outside the workbench by:
//   1. building a session-detail view model from the session's timeline items
//      (buildWorkspaceAgentSessionDetailViewModel), then
//   2. projecting it into a conversation view model (projectAgentConversationVM
//      or the useProjectedAgentConversation hook), then
//   3. feeding it to <AgentConversationFlow />.
//
// This is the same rendering path the AgentGUI node uses.

export { AgentConversationFlow } from "../shared/agentConversation/components/AgentConversationFlow";
export { AgentTranscriptView } from "../shared/agentConversation/components/AgentTranscriptView";
export { AgentTranscriptSkeleton } from "../shared/agentConversation/components/AgentTranscriptSkeleton";

// Higher-level convenience wrapper: takes a session-detail view model, projects
// the conversation view model internally, and defaults the transcript labels from
// the package i18n (only `toolCallsLabel` is required). This is the easiest entry
// point for rendering a single session's conversation flow outside the node.
export { WorkspaceAgentSessionDetail } from "../shared/WorkspaceAgentSessionDetail";

export {
  projectAgentConversationVM,
  reconcileProjectedAgentConversationVM
} from "../shared/agentConversation/projection/agentConversationProjection";
export { useProjectedAgentConversation } from "../shared/agentConversation/projection/useProjectedAgentConversation";

export { buildWorkspaceAgentSessionDetailViewModel } from "../shared/workspaceAgentSessionDetailViewModel";
export type {
  BuildWorkspaceAgentSessionDetailInput,
  WorkspaceAgentSessionDetailViewModel
} from "../shared/workspaceAgentSessionDetailViewModel";

export type { AgentConversationVM } from "../shared/agentConversation/contracts/agentConversationVM";
export type {
  WorkspaceAgentActivitySession,
  WorkspaceAgentActivityTimelineItem
} from "../shared/workspaceAgentActivityTypes";
export type { WorkspaceAgentActivityCard } from "../shared/workspaceAgentActivityListViewModel";
