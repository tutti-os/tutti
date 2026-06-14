import type { ToolCallStatusKind } from "../../workspaceAgentToolCallDisplay";
import type { WorkspaceAgentActivityTimelineItem } from "../../workspaceAgentActivityTypes";

export interface AgentMessageContentVM {
  kind: "message-content";
  id: string;
  turnId: string;
  body: string;
  copyText?: string | null;
  statusKind?: ToolCallStatusKind | null;
  contentKind?: "text" | "image-grid" | "plan";
  images?: AgentMessageImageVM[];
  occurredAtUnixMs: number | null;
  visibleError?: {
    code: string | null;
    phase: string | null;
    provider: string | null;
    detail: string | null;
    retryable: boolean | null;
  } | null;
  systemNotice?: {
    noticeKind: string | null;
    severity: string | null;
    title: string | null;
    detail: string | null;
    retryable: boolean | null;
  } | null;
  sourceTimelineItems?: WorkspaceAgentActivityTimelineItem[];
}

export interface AgentMessageImageVM {
  id: string;
  workspaceId?: string | null;
  agentSessionId: string;
  attachmentId?: string | null;
  mimeType: string;
  name?: string | null;
  data?: string | null;
}

export interface AgentThinkingContentVM {
  kind: "thinking-content";
  id: string;
  turnId: string;
  body: string;
  statusKind?: ToolCallStatusKind | null;
  occurredAtUnixMs: number | null;
  sourceTimelineItems?: WorkspaceAgentActivityTimelineItem[];
}

export interface AgentMessageRowVM {
  kind: "message";
  id: string;
  turnId: string;
  speaker: "user" | "assistant";
  messages: AgentMessageContentVM[];
  thinking: AgentThinkingContentVM[];
  occurredAtUnixMs: number | null;
}
