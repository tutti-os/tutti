import { describe, expect, it } from "vitest";
import { shouldShowAgentComposerStopButton } from "./useComposerPresentation";

describe("shouldShowAgentComposerStopButton", () => {
  it("lets a Tutti aggregate Stop yield to a typed draft", () => {
    expect(
      shouldShowAgentComposerStopButton({
        draftOverridesStopButton: true,
        hasDraftContent: true,
        isQueueMode: false,
        showStopButton: true
      })
    ).toBe(false);
  });

  it("keeps aggregate Stop visible while the draft is empty", () => {
    expect(
      shouldShowAgentComposerStopButton({
        draftOverridesStopButton: true,
        hasDraftContent: false,
        isQueueMode: false,
        showStopButton: true
      })
    ).toBe(true);
  });

  it("preserves the ordinary busy queue behavior", () => {
    expect(
      shouldShowAgentComposerStopButton({
        draftOverridesStopButton: false,
        hasDraftContent: true,
        isQueueMode: true,
        showStopButton: true
      })
    ).toBe(false);
  });
});
