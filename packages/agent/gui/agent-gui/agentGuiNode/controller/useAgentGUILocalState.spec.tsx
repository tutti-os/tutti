import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useAgentGUILocalState } from "./useAgentGUILocalState";

describe("useAgentGUILocalState home project intent", () => {
  it("distinguishes an unresolved default from an explicit no-project selection", () => {
    const { result } = renderHook(() =>
      useAgentGUILocalState({
        data: {
          lastActiveAgentSessionId: null,
          provider: "codex"
        },
        userProjectsApi: undefined
      })
    );

    expect(result.current.selectedProjectPath).toBeNull();
    expect(result.current.shouldApplyPreparedProjectSelection).toBe(true);

    act(() => result.current.setSelectedProjectPath("/workspace/alpha"));
    expect(result.current.selectedProjectPath).toBe("/workspace/alpha");
    expect(result.current.shouldApplyPreparedProjectSelection).toBe(false);

    act(() => result.current.setSelectedProjectPath(null));
    expect(result.current.selectedProjectPath).toBeNull();
    expect(result.current.shouldApplyPreparedProjectSelection).toBe(false);
  });
});
