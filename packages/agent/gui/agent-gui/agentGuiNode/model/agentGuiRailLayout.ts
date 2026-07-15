function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// Keep aligned with the issue manager task-list rail dimensions.
export const AGENT_GUI_CONVERSATION_RAIL_DEFAULT_WIDTH_PX = 280;
export const AGENT_GUI_CONVERSATION_RAIL_MIN_WIDTH_PX = 248;
export const AGENT_GUI_CONVERSATION_RAIL_MAX_WIDTH_PX = 520;
export const AGENT_GUI_DETAIL_MIN_WIDTH_PX = 220;
export const AGENT_GUI_HOME_COMPOSER_MIN_WIDTH_PX = 320;
export const AGENT_GUI_RAIL_RESIZE_HANDLE_WIDTH_PX = 10;
export const AGENT_GUI_COLLAPSED_MIN_WIDTH_PX = 460;
export const AGENT_GUI_EXPANDED_MIN_WIDTH_PX =
  AGENT_GUI_CONVERSATION_RAIL_MIN_WIDTH_PX +
  AGENT_GUI_DETAIL_MIN_WIDTH_PX +
  AGENT_GUI_RAIL_RESIZE_HANDLE_WIDTH_PX;
export const AGENT_GUI_AUTO_COLLAPSE_WIDTH_PX = 610;
// The standalone agent window keeps the conversation rail visible until the
// home composer reaches its actual minimum width. Include the provider rail in
// this host-specific threshold: 248px conversation rail + 320px composer +
// 10px resize handle + 52px provider rail = 630px.
export const AGENT_GUI_STANDALONE_AUTO_COLLAPSE_WIDTH_PX =
  AGENT_GUI_CONVERSATION_RAIL_MIN_WIDTH_PX +
  AGENT_GUI_HOME_COMPOSER_MIN_WIDTH_PX +
  AGENT_GUI_RAIL_RESIZE_HANDLE_WIDTH_PX +
  52;
export const AGENT_GUI_EXPANDED_TARGET_WIDTH_PX = 800;

export interface AgentGUIExpandedWindowFrameInput {
  position: { x: number; y: number };
  width: number;
  height: number;
  desktopSize: { width: number; height: number };
  conversationRailWidthPx: number | null | undefined;
}

export function shouldAutoCollapseAgentGUIConversationRail(
  containerWidthPx: number,
  autoCollapseWidthPx: number = AGENT_GUI_AUTO_COLLAPSE_WIDTH_PX
): boolean {
  return (
    Number.isFinite(containerWidthPx) &&
    containerWidthPx > 0 &&
    containerWidthPx <= autoCollapseWidthPx
  );
}

export function resolveAgentGUIConversationRailMaxWidthPx(
  containerWidthPx: number
): number {
  const safeContainerWidth =
    Number.isFinite(containerWidthPx) && containerWidthPx > 0
      ? containerWidthPx
      : AGENT_GUI_CONVERSATION_RAIL_DEFAULT_WIDTH_PX +
        AGENT_GUI_DETAIL_MIN_WIDTH_PX +
        AGENT_GUI_RAIL_RESIZE_HANDLE_WIDTH_PX;

  return Math.max(
    AGENT_GUI_CONVERSATION_RAIL_MIN_WIDTH_PX,
    Math.min(
      AGENT_GUI_CONVERSATION_RAIL_MAX_WIDTH_PX,
      safeContainerWidth -
        AGENT_GUI_DETAIL_MIN_WIDTH_PX -
        AGENT_GUI_RAIL_RESIZE_HANDLE_WIDTH_PX
    )
  );
}

export function clampAgentGUIConversationRailWidthPx(
  widthPx: number | null | undefined,
  containerWidthPx: number
): number {
  const preferredWidthPx =
    typeof widthPx === "number" && Number.isFinite(widthPx)
      ? Math.round(widthPx)
      : null;

  return clamp(
    preferredWidthPx ?? AGENT_GUI_CONVERSATION_RAIL_DEFAULT_WIDTH_PX,
    AGENT_GUI_CONVERSATION_RAIL_MIN_WIDTH_PX,
    resolveAgentGUIConversationRailMaxWidthPx(containerWidthPx)
  );
}

export function resolveNextAgentGUIConversationRailWidthPx(input: {
  currentWidthPx: number | null | undefined;
  requestedWidthPx: number;
  containerWidthPx: number;
}): number | null {
  const nextWidthPx = clampAgentGUIConversationRailWidthPx(
    input.requestedWidthPx,
    input.containerWidthPx
  );
  if (input.currentWidthPx === nextWidthPx) {
    return input.currentWidthPx;
  }

  if (input.currentWidthPx === null || input.currentWidthPx === undefined) {
    const defaultWidthPx = clampAgentGUIConversationRailWidthPx(
      null,
      input.containerWidthPx
    );
    if (nextWidthPx === defaultWidthPx) {
      return null;
    }
  }

  return nextWidthPx;
}

export function resolveAgentGUIExpandedWindowFrame(
  input: AgentGUIExpandedWindowFrameInput
): {
  position: { x: number; y: number };
  size: { width: number; height: number };
} {
  const desiredRailWidthPx = clampAgentGUIConversationRailWidthPx(
    input.conversationRailWidthPx,
    AGENT_GUI_CONVERSATION_RAIL_MAX_WIDTH_PX +
      AGENT_GUI_DETAIL_MIN_WIDTH_PX +
      AGENT_GUI_RAIL_RESIZE_HANDLE_WIDTH_PX
  );
  const desiredWidthPx = Math.max(
    Math.round(input.width),
    desiredRailWidthPx +
      AGENT_GUI_DETAIL_MIN_WIDTH_PX +
      AGENT_GUI_RAIL_RESIZE_HANDLE_WIDTH_PX,
    AGENT_GUI_EXPANDED_MIN_WIDTH_PX,
    AGENT_GUI_EXPANDED_TARGET_WIDTH_PX
  );
  const desktopWidthPx =
    Number.isFinite(input.desktopSize.width) && input.desktopSize.width > 0
      ? Math.round(input.desktopSize.width)
      : desiredWidthPx;
  const nextWidthPx = Math.min(desiredWidthPx, desktopWidthPx);
  const maxX = Math.max(0, desktopWidthPx - nextWidthPx);
  const nextX = clamp(Math.round(input.position.x), 0, maxX);

  return {
    position: {
      x: nextX,
      y: input.position.y
    },
    size: {
      width: nextWidthPx,
      height: input.height
    }
  };
}
