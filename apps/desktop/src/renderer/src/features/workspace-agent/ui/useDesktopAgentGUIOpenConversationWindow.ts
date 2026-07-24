import { useLayoutEffect, useMemo, useRef } from "react";
import type { DesktopAgentGUIProvider } from "../desktopAgentGUINodeState.ts";
import type { DesktopAgentGUIWorkbenchBodyProps } from "./desktopAgentGUIWorkbenchModel.ts";

export function useDesktopAgentGUIOpenConversationWindow(input: {
  agentTargetId: string | null;
  onOpenAgentConversationWindow: DesktopAgentGUIWorkbenchBodyProps["onOpenAgentConversationWindow"];
  provider: DesktopAgentGUIProvider;
  workspaceId: string;
}): ((agentSessionId: string) => void) | undefined {
  const currentInputRef = useRef(input);
  useLayoutEffect(() => {
    currentInputRef.current = input;
  }, [input]);

  const enabled = Boolean(input.onOpenAgentConversationWindow);
  return useMemo(() => {
    if (!enabled) {
      return undefined;
    }
    return (agentSessionId: string) => {
      const current = currentInputRef.current;
      if (!current.onOpenAgentConversationWindow) {
        return;
      }
      const normalizedSessionId = agentSessionId.trim();
      if (!normalizedSessionId) {
        return;
      }
      void current.onOpenAgentConversationWindow({
        agentSessionId: normalizedSessionId,
        agentTargetId: current.agentTargetId,
        provider: current.provider,
        workspaceId: current.workspaceId
      });
    };
  }, [enabled]);
}
