import { useEffect, useRef, type RefObject } from "react";
import { AgentGUIPanelEngagementController } from "./AgentGUIPanelEngagementController";
import type {
  AgentGUIComposerEngagement,
  AgentGUIEngagementContext,
  AgentGUIEngagementEventSink
} from "./agentGUIEngagement.types";

export {
  AGENT_GUI_PANEL_EXPOSURE_DWELL_MS,
  AGENT_GUI_PANEL_EXPOSURE_INTERSECTION_RATIO
} from "./AgentGUIPanelEngagementController";

interface AgentGUIPanelEngagementInput {
  context: AgentGUIEngagementContext;
  contextKey: string;
  elementRef: RefObject<HTMLElement | null>;
  isActive: boolean;
  isVisible: boolean;
  onEvent?: AgentGUIEngagementEventSink;
}

export function useAgentGUIPanelEngagement(
  input: AgentGUIPanelEngagementInput
): AgentGUIComposerEngagement | undefined {
  const inputRef = useRef(input);
  const controllerRef = useRef<AgentGUIPanelEngagementController | null>(null);
  const intersectionRatioRef = useRef(0);
  const engagementRef = useRef<AgentGUIComposerEngagement | null>(null);
  inputRef.current = input;

  if (!engagementRef.current) {
    engagementRef.current = {
      contentEntered(content) {
        controllerRef.current?.contentEntered(content);
      },
      focused(focusMethod) {
        controllerRef.current?.focused(focusMethod);
      }
    };
  }

  const engagementEnabled = Boolean(input.onEvent);
  useEffect(() => {
    const element = input.elementRef.current;
    if (!engagementEnabled || !element) return undefined;

    const controller = new AgentGUIPanelEngagementController({
      element,
      getInput: () => inputRef.current,
      initialIntersectionRatio: intersectionRatioRef.current,
      visitContextKey: input.contextKey
    });
    controllerRef.current = controller;
    controller.attach();
    return () => {
      intersectionRatioRef.current = controller.dispose();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, [
    engagementEnabled,
    input.contextKey,
    input.elementRef,
    input.isActive,
    input.isVisible
  ]);

  return engagementEnabled ? engagementRef.current : undefined;
}
