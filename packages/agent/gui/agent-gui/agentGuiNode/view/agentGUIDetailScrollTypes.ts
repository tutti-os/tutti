import type { MutableRefObject, RefObject } from "react";
import type { AgentTranscriptVirtualScrollController } from "../../../shared/agentConversation/components/AgentTranscriptView";
import type { AgentConversationVM } from "../../../shared/agentConversation/contracts/agentConversationVM";
import type { AgentGUINodeViewProps } from "../AgentGUINodeView";
import type { AgentGUINodeViewModel } from "../model/agentGuiNodeTypes";
import type { TimelineScrollAnchor } from "./agentGUIScrollMemory";

export interface AgentGUIDetailScrollInput {
  actions: AgentGUINodeViewProps["actions"];
  bottomDockRef: RefObject<HTMLDivElement | null>;
  bottomDockStoreRevision: string;
  conversation: AgentConversationVM | null;
  isVisible: boolean;
  pendingPrependScrollAnchorRef: MutableRefObject<{
    conversationId: string;
    scrollHeight: number;
    scrollTop: number;
  } | null>;
  showTimelineSkeleton: boolean;
  submittedPromptScrollConversationRef: MutableRefObject<string | null>;
  timelineConversationId: string | null;
  timelineContentRef: RefObject<HTMLDivElement | null>;
  timelineRef: RefObject<HTMLDivElement | null>;
  timelineScrollAnchorRef: MutableRefObject<TimelineScrollAnchor | null>;
  virtualScrollControllerRef: RefObject<AgentTranscriptVirtualScrollController | null>;
  viewModel: AgentGUINodeViewModel;
}
