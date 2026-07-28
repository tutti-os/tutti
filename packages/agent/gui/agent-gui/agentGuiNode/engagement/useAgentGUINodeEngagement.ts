import { useRef, type RefObject } from "react";
import type { AgentGUINodeViewModel } from "../model/agentGuiNodeTypes";
import type {
  AgentGUIComposerEngagement,
  AgentGUIEngagementEventSink
} from "./agentGUIEngagement.types";
import { projectAgentGUIEngagementContext } from "./projectAgentGUIEngagementContext";
import { useAgentGUIPanelEngagement } from "./useAgentGUIPanelEngagement";

export function useAgentGUINodeEngagement(input: {
  composerReady: boolean;
  isActive: boolean;
  isVisible: boolean;
  onEvent?: AgentGUIEngagementEventSink;
  viewModel: AgentGUINodeViewModel;
}): {
  composerEngagement: AgentGUIComposerEngagement | undefined;
  layoutElementRef: RefObject<HTMLDivElement | null>;
} {
  const layoutElementRef = useRef<HTMLDivElement | null>(null);
  const projected = projectAgentGUIEngagementContext(
    input.viewModel,
    input.composerReady
  );
  return {
    composerEngagement: useAgentGUIPanelEngagement({
      ...projected,
      elementRef: layoutElementRef,
      isActive: input.isActive,
      isVisible: input.isVisible,
      onEvent: input.onEvent
    }),
    layoutElementRef
  };
}
