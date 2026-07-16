import { describe, expect, it } from "vitest";
import { resolveTuttiModeUpdateInlineNotice } from "./useAgentGUIDetailModel";

describe("resolveTuttiModeUpdateInlineNotice", () => {
  it("projects a failed activation update into a retryable inline error", () => {
    const update = {
      // This diagnostic detail remains available to diagnostic projections,
      // but user-facing presentation must not expose it.
      error: "network unavailable",
      failedMessage: "Tutti mode couldn't be updated. Try again.",
      status: "failed" as const,
      uncertainMessage: "Still reconciling"
    };
    expect(resolveTuttiModeUpdateInlineNotice(update)).toEqual({
      autoDismissMs: null,
      id: "agent-gui-tutti-mode-update-failed",
      message: "Tutti mode couldn't be updated. Try again.",
      tone: "error"
    });
  });

  it("projects uncertain delivery as a non-blocking warning", () => {
    expect(
      resolveTuttiModeUpdateInlineNotice({
        failedMessage: "Update failed",
        status: "uncertain",
        uncertainMessage: "Tutti mode is still being reconciled"
      })
    ).toEqual({
      autoDismissMs: null,
      id: "agent-gui-tutti-mode-update-uncertain",
      message: "Tutti mode is still being reconciled",
      tone: "warning"
    });
  });
});
