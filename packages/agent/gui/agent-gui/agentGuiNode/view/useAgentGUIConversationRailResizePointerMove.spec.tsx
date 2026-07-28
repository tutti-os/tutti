import { act, renderHook } from "@testing-library/react";
import type { PointerEvent } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  useAgentGUIConversationRailResizePointerMove,
  type AgentGUIConversationRailResizeInteraction
} from "./useAgentGUIConversationRailResizePointerMove";

describe("useAgentGUIConversationRailResizePointerMove", () => {
  it("reports live host layout from the clamped drag width", () => {
    const layoutElement = document.createElement("div");
    const resizeHandle = document.createElement("div");
    const onConversationRailLayoutChange = vi.fn();
    const railResizeInteractionRef: {
      current: AgentGUIConversationRailResizeInteraction | null;
    } = {
      current: {
        lastWidthPx: 240,
        pointerId: 7,
        startClientX: 100,
        startWidthPx: 240
      }
    };
    const { result } = renderHook(() =>
      useAgentGUIConversationRailResizePointerMove({
        clampConversationRailWidth: (widthPx) => Math.min(280, widthPx),
        layoutElementRef: { current: layoutElement },
        onConversationRailLayoutChange,
        providerRailWidthPx: 52,
        railResizeInteractionRef
      })
    );

    act(() => {
      result.current({
        clientX: 160,
        currentTarget: resizeHandle,
        pointerId: 7
      } as unknown as PointerEvent<HTMLDivElement>);
    });

    expect(railResizeInteractionRef.current?.lastWidthPx).toBe(280);
    expect(
      layoutElement.style.getPropertyValue(
        "--agent-gui-conversation-rail-width"
      )
    ).toBe("280px");
    expect(resizeHandle.getAttribute("aria-valuenow")).toBe("280");
    expect(onConversationRailLayoutChange).toHaveBeenCalledWith({
      providerRailWidthPx: 52,
      conversationRailWidthPx: 280,
      leftPanelWidthPx: 332,
      resizing: true
    });
  });
});
