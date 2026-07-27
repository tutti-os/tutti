import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useAgentGUIComposerInputHistoryProps } from "./useAgentGUIComposerInputHistoryProps";

describe("useAgentGUIComposerInputHistoryProps", () => {
  it("keeps one open-period store and exposes it only when enabled", () => {
    const { result, rerender } = renderHook(
      ({ enabled }) => useAgentGUIComposerInputHistoryProps({ enabled }),
      { initialProps: { enabled: false } }
    );

    expect(result.current.inputHistoryStore).toBeUndefined();

    rerender({ enabled: true });
    const openPeriodStore = result.current.inputHistoryStore;
    expect(openPeriodStore).toBeDefined();

    rerender({ enabled: false });
    expect(result.current.inputHistoryStore).toBeUndefined();

    rerender({ enabled: true });
    expect(result.current.inputHistoryStore).toBe(openPeriodStore);
  });
});
