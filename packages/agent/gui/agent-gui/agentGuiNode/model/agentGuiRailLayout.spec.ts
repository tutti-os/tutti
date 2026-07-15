import { describe, expect, it } from "vitest";
import {
  AGENT_GUI_CONVERSATION_RAIL_DEFAULT_WIDTH_PX,
  AGENT_GUI_AUTO_COLLAPSE_WIDTH_PX,
  AGENT_GUI_CONVERSATION_RAIL_MAX_WIDTH_PX,
  AGENT_GUI_CONVERSATION_RAIL_MIN_WIDTH_PX,
  AGENT_GUI_COLLAPSED_MIN_WIDTH_PX,
  AGENT_GUI_DETAIL_MIN_WIDTH_PX,
  AGENT_GUI_EXPANDED_MIN_WIDTH_PX,
  AGENT_GUI_EXPANDED_TARGET_WIDTH_PX,
  AGENT_GUI_RAIL_RESIZE_HANDLE_WIDTH_PX,
  AGENT_GUI_STANDALONE_AUTO_COLLAPSE_WIDTH_PX,
  clampAgentGUIConversationRailWidthPx,
  resolveAgentGUIExpandedWindowFrame,
  resolveNextAgentGUIConversationRailWidthPx,
  shouldAutoCollapseAgentGUIConversationRail
} from "./agentGuiRailLayout";

describe("agentGuiRailLayout", () => {
  it("matches the issue manager task-list rail dimensions", () => {
    expect(AGENT_GUI_CONVERSATION_RAIL_DEFAULT_WIDTH_PX).toBe(280);
    expect(AGENT_GUI_CONVERSATION_RAIL_MIN_WIDTH_PX).toBe(248);
    expect(AGENT_GUI_CONVERSATION_RAIL_MAX_WIDTH_PX).toBe(520);
  });

  it("returns the default rail width when no persisted width exists", () => {
    expect(clampAgentGUIConversationRailWidthPx(null, 720)).toBe(
      AGENT_GUI_CONVERSATION_RAIL_DEFAULT_WIDTH_PX
    );
  });

  it("clamps the rail width to the configured minimum and maximum bounds", () => {
    expect(clampAgentGUIConversationRailWidthPx(120, 900)).toBe(
      AGENT_GUI_CONVERSATION_RAIL_MIN_WIDTH_PX
    );
    expect(clampAgentGUIConversationRailWidthPx(999, 1200)).toBe(
      AGENT_GUI_CONVERSATION_RAIL_MAX_WIDTH_PX
    );
  });

  it("shrinks the effective maximum width to preserve detail-pane minimum width", () => {
    expect(clampAgentGUIConversationRailWidthPx(520, 600)).toBe(
      600 -
        AGENT_GUI_DETAIL_MIN_WIDTH_PX -
        AGENT_GUI_RAIL_RESIZE_HANDLE_WIDTH_PX
    );
  });

  it("clamps the conversation rail to its minimum when the container reaches its narrowest width", () => {
    expect(
      clampAgentGUIConversationRailWidthPx(
        null,
        AGENT_GUI_COLLAPSED_MIN_WIDTH_PX
      )
    ).toBe(AGENT_GUI_CONVERSATION_RAIL_MIN_WIDTH_PX);
    expect(
      clampAgentGUIConversationRailWidthPx(
        420,
        AGENT_GUI_COLLAPSED_MIN_WIDTH_PX
      )
    ).toBe(AGENT_GUI_CONVERSATION_RAIL_MIN_WIDTH_PX);
  });

  it("auto-collapses the rail at and below the compact conversation width", () => {
    expect(AGENT_GUI_AUTO_COLLAPSE_WIDTH_PX).toBe(610);
    expect(
      shouldAutoCollapseAgentGUIConversationRail(
        AGENT_GUI_AUTO_COLLAPSE_WIDTH_PX
      )
    ).toBe(true);
    expect(
      shouldAutoCollapseAgentGUIConversationRail(
        AGENT_GUI_AUTO_COLLAPSE_WIDTH_PX + 1
      )
    ).toBe(false);
    expect(
      shouldAutoCollapseAgentGUIConversationRail(
        AGENT_GUI_AUTO_COLLAPSE_WIDTH_PX - 1
      )
    ).toBe(true);
    expect(
      shouldAutoCollapseAgentGUIConversationRail(
        AGENT_GUI_EXPANDED_MIN_WIDTH_PX
      )
    ).toBe(true);
    expect(shouldAutoCollapseAgentGUIConversationRail(0)).toBe(false);
  });

  it("auto-collapses against a host-provided threshold", () => {
    expect(AGENT_GUI_STANDALONE_AUTO_COLLAPSE_WIDTH_PX).toBe(630);
    expect(
      shouldAutoCollapseAgentGUIConversationRail(
        AGENT_GUI_STANDALONE_AUTO_COLLAPSE_WIDTH_PX,
        AGENT_GUI_STANDALONE_AUTO_COLLAPSE_WIDTH_PX
      )
    ).toBe(true);
    expect(
      shouldAutoCollapseAgentGUIConversationRail(
        AGENT_GUI_STANDALONE_AUTO_COLLAPSE_WIDTH_PX + 1,
        AGENT_GUI_STANDALONE_AUTO_COLLAPSE_WIDTH_PX
      )
    ).toBe(false);
    expect(
      shouldAutoCollapseAgentGUIConversationRail(
        AGENT_GUI_STANDALONE_AUTO_COLLAPSE_WIDTH_PX - 1,
        AGENT_GUI_STANDALONE_AUTO_COLLAPSE_WIDTH_PX
      )
    ).toBe(true);
    expect(
      shouldAutoCollapseAgentGUIConversationRail(
        0,
        AGENT_GUI_STANDALONE_AUTO_COLLAPSE_WIDTH_PX
      )
    ).toBe(false);
  });

  it("keeps an untouched rail width unpersisted when it still matches the default", () => {
    expect(
      resolveNextAgentGUIConversationRailWidthPx({
        currentWidthPx: null,
        requestedWidthPx: AGENT_GUI_CONVERSATION_RAIL_DEFAULT_WIDTH_PX,
        containerWidthPx: 720
      })
    ).toBeNull();
  });

  it("persists a changed rail width after clamping it into bounds", () => {
    expect(
      resolveNextAgentGUIConversationRailWidthPx({
        currentWidthPx: 240,
        requestedWidthPx: 520,
        containerWidthPx: 600
      })
    ).toBe(
      600 -
        AGENT_GUI_DETAIL_MIN_WIDTH_PX -
        AGENT_GUI_RAIL_RESIZE_HANDLE_WIDTH_PX
    );
  });

  it("resolves the minimum window frame that can show the rail and detail panes", () => {
    expect(AGENT_GUI_EXPANDED_TARGET_WIDTH_PX).toBe(800);
    expect(
      resolveAgentGUIExpandedWindowFrame({
        position: { x: 40, y: 80 },
        width: 500,
        height: 560,
        desktopSize: { width: 1200, height: 800 },
        conversationRailWidthPx: 280
      })
    ).toEqual({
      position: { x: 40, y: 80 },
      size: {
        width: AGENT_GUI_EXPANDED_TARGET_WIDTH_PX,
        height: 560
      }
    });
  });

  it("keeps the expanded window inside the desktop width", () => {
    expect(
      resolveAgentGUIExpandedWindowFrame({
        position: { x: 700, y: 80 },
        width: 500,
        height: 560,
        desktopSize: { width: 900, height: 800 },
        conversationRailWidthPx: 280
      })
    ).toEqual({
      position: { x: 100, y: 80 },
      size: {
        width: AGENT_GUI_EXPANDED_TARGET_WIDTH_PX,
        height: 560
      }
    });
  });
});
