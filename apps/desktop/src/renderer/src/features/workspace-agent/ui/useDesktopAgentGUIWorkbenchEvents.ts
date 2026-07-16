import { useEffect, useRef, useState } from "react";
import {
  AGENT_GUI_WORKBENCH_NEW_CONVERSATION_EVENT,
  type AgentGuiWorkbenchNewConversationDetail
} from "@tutti-os/agent-gui/workbench/contribution";
import {
  DESKTOP_AGENT_GUI_CONVERSATION_RAIL_TOGGLE_EVENT,
  type DesktopAgentGUIConversationRailToggleDetail
} from "./desktopAgentGUIWorkbenchModel.ts";

export function useDesktopAgentGUIWorkbenchEvents(input: {
  instanceId: string;
  onConversationRailToggle(collapsed: boolean): void;
  previewMode: boolean;
}): number {
  const [newConversationSequence, setNewConversationSequence] = useState(0);
  const onConversationRailToggleRef = useRef(input.onConversationRailToggle);
  onConversationRailToggleRef.current = input.onConversationRailToggle;

  useEffect(() => {
    if (input.previewMode) {
      return;
    }
    const handleConversationRailToggle = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      if (!detail || typeof detail !== "object") {
        return;
      }
      const toggle =
        detail as Partial<DesktopAgentGUIConversationRailToggleDetail>;
      if (
        toggle.instanceId === input.instanceId &&
        typeof toggle.conversationRailCollapsed === "boolean"
      ) {
        onConversationRailToggleRef.current(toggle.conversationRailCollapsed);
      }
    };
    const handleNewConversation = (event: Event) => {
      const request = (event as CustomEvent<unknown>)
        .detail as Partial<AgentGuiWorkbenchNewConversationDetail> | null;
      if (request?.instanceId === input.instanceId) {
        setNewConversationSequence((current) => current + 1);
      }
    };
    window.addEventListener(
      DESKTOP_AGENT_GUI_CONVERSATION_RAIL_TOGGLE_EVENT,
      handleConversationRailToggle
    );
    window.addEventListener(
      AGENT_GUI_WORKBENCH_NEW_CONVERSATION_EVENT,
      handleNewConversation
    );
    return () => {
      window.removeEventListener(
        DESKTOP_AGENT_GUI_CONVERSATION_RAIL_TOGGLE_EVENT,
        handleConversationRailToggle
      );
      window.removeEventListener(
        AGENT_GUI_WORKBENCH_NEW_CONVERSATION_EVENT,
        handleNewConversation
      );
    };
  }, [input.instanceId, input.previewMode]);

  return newConversationSequence;
}
