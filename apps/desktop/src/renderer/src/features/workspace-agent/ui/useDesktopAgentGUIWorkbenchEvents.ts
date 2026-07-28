import { useEffect, useRef, useState } from "react";
import {
  AGENT_GUI_WORKBENCH_NEW_CONVERSATION_EVENT,
  AGENT_GUI_WORKBENCH_SESSION_ACTION_EVENT,
  isAgentGuiWorkbenchSessionAction,
  type AgentGuiWorkbenchNewConversationDetail,
  type AgentGuiWorkbenchSessionActionDetail,
  type AgentGuiWorkbenchSessionActionRequest
} from "@tutti-os/agent-gui/workbench/contribution";
import {
  DESKTOP_AGENT_GUI_CONVERSATION_RAIL_TOGGLE_EVENT,
  type DesktopAgentGUIConversationRailToggleDetail
} from "./desktopAgentGUIWorkbenchModel.ts";

export type DesktopAgentGUISessionActionRequest =
  AgentGuiWorkbenchSessionActionRequest;

export function useDesktopAgentGUIWorkbenchEvents(input: {
  instanceId: string;
  onConversationRailToggle(collapsed: boolean): void;
}): {
  newConversationSequence: number;
  sessionActionRequest: DesktopAgentGUISessionActionRequest | null;
} {
  const [newConversationSequence, setNewConversationSequence] = useState(0);
  const [sessionActionRequest, setSessionActionRequest] =
    useState<DesktopAgentGUISessionActionRequest | null>(null);
  const onConversationRailToggleRef = useRef(input.onConversationRailToggle);
  onConversationRailToggleRef.current = input.onConversationRailToggle;

  useEffect(() => {
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
    const handleSessionAction = (event: Event) => {
      const request = (event as CustomEvent<unknown>)
        .detail as Partial<AgentGuiWorkbenchSessionActionDetail> | null;
      if (
        request?.instanceId === input.instanceId &&
        isAgentGuiWorkbenchSessionAction(request.action)
      ) {
        const action = request.action;
        const agentSessionId =
          typeof request.agentSessionId === "string" &&
          request.agentSessionId.trim()
            ? request.agentSessionId
            : null;
        setSessionActionRequest((current) => ({
          action,
          agentSessionId,
          sequence: (current?.sequence ?? 0) + 1
        }));
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
    window.addEventListener(
      AGENT_GUI_WORKBENCH_SESSION_ACTION_EVENT,
      handleSessionAction
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
      window.removeEventListener(
        AGENT_GUI_WORKBENCH_SESSION_ACTION_EVENT,
        handleSessionAction
      );
    };
  }, [input.instanceId]);

  return { newConversationSequence, sessionActionRequest };
}
