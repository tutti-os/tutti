import { describe, expect, it, vi } from "vitest";
import {
  shouldShowAgentComposerStopButton,
  submitInteractivePromptWithAck
} from "./useComposerPresentation";

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

describe("submitInteractivePromptWithAck", () => {
  it("dismisses only after the runtime acknowledges the response", async () => {
    const dismiss = vi.fn();
    let acknowledge!: () => void;
    const pending = submitInteractivePromptWithAck(
      { requestId: "request-1", optionId: "allow" },
      {
        submit: () =>
          new Promise<void>((resolve) => {
            acknowledge = resolve;
          }),
        isCurrent: () => true,
        dismiss
      }
    );
    expect(dismiss).not.toHaveBeenCalled();
    acknowledge();
    await expect(pending).resolves.toBe(true);
    expect(dismiss).toHaveBeenCalledWith("request-1");
  });

  it("keeps a rejected prompt actionable", async () => {
    const dismiss = vi.fn();
    await expect(
      submitInteractivePromptWithAck(
        { requestId: "request-1", optionId: "allow" },
        {
          submit: async () => {
            throw new Error("network unavailable");
          },
          isCurrent: () => true,
          dismiss
        }
      )
    ).resolves.toBe(false);
    expect(dismiss).not.toHaveBeenCalled();
  });
});
