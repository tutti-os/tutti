import { useCallback, type PointerEvent } from "react";
import type { AgentGUINodeViewProps } from "./AgentGUINodeView.types";
import { useOptionalStableEventCallback } from "./agentGUIViewUtils";

export interface AgentGUIConversationRailResizeInteraction {
  lastWidthPx: number;
  pointerId: number;
  startClientX: number;
  startWidthPx: number;
}

interface UseAgentGUIConversationRailResizePointerMoveInput {
  clampConversationRailWidth: (widthPx: number) => number;
  layoutElementRef: { current: HTMLElement | null };
  onConversationRailLayoutChange: AgentGUINodeViewProps["onConversationRailLayoutChange"];
  providerRailWidthPx: number;
  railResizeInteractionRef: {
    current: AgentGUIConversationRailResizeInteraction | null;
  };
}

export function useAgentGUIConversationRailResizePointerMove({
  clampConversationRailWidth,
  layoutElementRef,
  onConversationRailLayoutChange,
  providerRailWidthPx,
  railResizeInteractionRef
}: UseAgentGUIConversationRailResizePointerMoveInput): (
  event: PointerEvent<HTMLDivElement>
) => void {
  const reportConversationRailLayoutChange = useOptionalStableEventCallback(
    onConversationRailLayoutChange
  );

  return useCallback(
    (event: PointerEvent<HTMLDivElement>): void => {
      const resizeState = railResizeInteractionRef.current;
      if (!resizeState || resizeState.pointerId !== event.pointerId) return;

      const nextWidthPx = clampConversationRailWidth(
        resizeState.startWidthPx + event.clientX - resizeState.startClientX
      );
      if (resizeState.lastWidthPx === nextWidthPx) return;

      resizeState.lastWidthPx = nextWidthPx;
      layoutElementRef.current?.style.setProperty(
        "--agent-gui-conversation-rail-width",
        `${nextWidthPx}px`
      );
      reportConversationRailLayoutChange?.({
        providerRailWidthPx,
        conversationRailWidthPx: nextWidthPx,
        leftPanelWidthPx: providerRailWidthPx + nextWidthPx,
        resizing: true
      });
      event.currentTarget.setAttribute("aria-valuenow", String(nextWidthPx));
    },
    [
      clampConversationRailWidth,
      layoutElementRef,
      providerRailWidthPx,
      railResizeInteractionRef,
      reportConversationRailLayoutChange
    ]
  );
}
