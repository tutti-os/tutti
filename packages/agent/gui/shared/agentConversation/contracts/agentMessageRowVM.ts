import type { AgentActivityMessageSemantics } from "@tutti-os/agent-activity-core";
import type { ToolCallStatusKind } from "../../workspaceAgentToolCallDisplay";
import type { WorkspaceAgentActivityTimelineItem } from "../../workspaceAgentTimelineTypes";
import type { AgentTranscriptPresentationKind } from "./agentTranscriptPresentation";
import type { AgentCollaborationVM } from "./agentCollaborationVM";
import type { AgentToolGroupRowVM } from "./agentToolGroupRowVM";

export interface AgentMessageContentVM {
  kind: "message-content";
  id: string;
  turnId: string;
  body: string;
  presentationKind: AgentTranscriptPresentationKind;
  copyText?: string | null;
  statusKind?: ToolCallStatusKind | null;
  contentKind?: "text" | "image-grid" | "plan" | "collaboration";
  isTurnFinalText?: true;
  /** Typed payload for `contentKind: "collaboration"` rows. */
  collaboration?: AgentCollaborationVM | null;
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
    source?: string | null;
    command?: AgentActivityMessageSemantics["noticeCommand"] | null;
    commandStatus?: AgentActivityMessageSemantics["noticeCommandStatus"] | null;
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
  url?: string | null;
  path?: string | null;
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
  /**
   * Tool-group rows that happened right before this message and are rendered
   * inside this message's block (under the participant header, above the
   * content) instead of as standalone transcript rows. Populated only for the
   * participant-header presentation (e.g. the Agent board session detail).
   */
  leadingToolRows?: AgentToolGroupRowVM[];
  occurredAtUnixMs: number | null;
}
