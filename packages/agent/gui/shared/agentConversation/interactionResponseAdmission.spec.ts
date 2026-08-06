import { describe, expect, it, vi } from "vitest";
import { submitAgentInteractionResponseAndDismiss } from "./interactionResponseAdmission";

describe("submitAgentInteractionResponseAndDismiss", () => {
  it("dismisses the prompt only after submission is admitted", () => {
    const dismiss = vi.fn();
    const response = { requestId: "request-1" };

    expect(
      submitAgentInteractionResponseAndDismiss({
        response,
        submit: () => false,
        dismiss
      })
    ).toBe(false);
    expect(dismiss).not.toHaveBeenCalled();

    expect(
      submitAgentInteractionResponseAndDismiss({
        response,
        submit: () => true,
        dismiss
      })
    ).toBe(true);
    expect(dismiss).toHaveBeenCalledOnce();
    expect(dismiss).toHaveBeenCalledWith("request-1");
  });
});
