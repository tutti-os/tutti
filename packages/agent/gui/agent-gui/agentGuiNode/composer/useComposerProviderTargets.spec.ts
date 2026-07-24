import { describe, expect, it } from "vitest";
import { resolveComposerHandoffDisabled } from "./useComposerProviderTargets";

describe("resolveComposerHandoffDisabled", () => {
  it("stays enabled when the current composer is disabled", () => {
    expect(
      resolveComposerHandoffDisabled({
        hasHandoffConversation: true
      })
    ).toBe(false);
  });

  it("disables handoff when the callback is missing", () => {
    expect(
      resolveComposerHandoffDisabled({
        hasHandoffConversation: false
      })
    ).toBe(true);
  });
});
