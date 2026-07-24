import { describe, expect, it } from "vitest";
import { resolveComposerHandoffDisabled } from "./useComposerProviderTargets";

describe("resolveComposerHandoffDisabled", () => {
  it("does not couple handoff availability to the current composer input", () => {
    expect(
      resolveComposerHandoffDisabled({
        composerControlsHardDisabled: false,
        hasHandoffConversation: true
      })
    ).toBe(false);
  });

  it.each([
    ["hard-disabled composer", { composerControlsHardDisabled: true }],
    ["missing handoff callback", { hasHandoffConversation: false }]
  ])("disables handoff when %s", (_reason, override) => {
    expect(
      resolveComposerHandoffDisabled({
        composerControlsHardDisabled: false,
        hasHandoffConversation: true,
        ...override
      })
    ).toBe(true);
  });
});
