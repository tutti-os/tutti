import { describe, expect, it } from "vitest";
import { resolveHandoffTargetOwnershipLabel } from "./handoffTargetPresentation";

const labels = { self: "My Agent", shared: "Shared Agent" };

describe("resolveHandoffTargetOwnershipLabel", () => {
  it("keeps a self-owned target local even when owner presentation is present", () => {
    expect(
      resolveHandoffTargetOwnershipLabel(
        { ownership: "self", ownerLabel: "Current User" },
        labels
      )
    ).toBe("My Agent");
  });

  it("identifies shared targets by owner name without changing the agent name", () => {
    expect(
      resolveHandoffTargetOwnershipLabel(
        { ownership: "shared", ownerLabel: " Ricky " },
        labels
      )
    ).toBe("Ricky · Shared Agent");
  });

  it("identifies a shared target when owner presentation is unavailable", () => {
    expect(
      resolveHandoffTargetOwnershipLabel({ ownership: "shared" }, labels)
    ).toBe("Shared Agent");
  });

  it("does not infer ownership from owner presentation", () => {
    expect(
      resolveHandoffTargetOwnershipLabel({ ownerLabel: "Current User" }, labels)
    ).toBeNull();
  });
});
