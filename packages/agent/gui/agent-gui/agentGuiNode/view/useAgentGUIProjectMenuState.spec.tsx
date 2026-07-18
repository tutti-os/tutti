import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useAgentGUIProjectMenuState } from "./useAgentGUIProjectMenuState";

describe("useAgentGUIProjectMenuState", () => {
  it("keeps the active menu lock when an older section closes", () => {
    const isRailInteractionLocked = () => false;
    const { result } = renderHook(() =>
      useAgentGUIProjectMenuState(isRailInteractionLocked, false)
    );
    const onProjectMenuOpenChange = result.current.onProjectMenuOpenChange;

    act(() => onProjectMenuOpenChange("project-a", true));
    act(() => onProjectMenuOpenChange("project-b", true));
    act(() => onProjectMenuOpenChange("project-a", false));
    expect(result.current.projectMenuOpen).toBe(true);

    act(() => onProjectMenuOpenChange("project-b", false));
    expect(result.current.projectMenuOpen).toBe(false);
    expect(result.current.onProjectMenuOpenChange).toBe(
      onProjectMenuOpenChange
    );
  });
});
