import { describe, expect, it, vi } from "vitest";
import { inspectAgentConversationBatchDeletionCapability } from "./agentConversationBatchDeletionCapability";

describe("inspectAgentConversationBatchDeletionCapability", () => {
  it("enables batch deletion only when both runtime methods exist", () => {
    expect(
      inspectAgentConversationBatchDeletionCapability({
        deleteSessionsBatch: vi.fn(),
        listSessionSectionDeletionCandidates: vi.fn()
      })
    ).toEqual({
      available: true,
      missingMethods: [],
      partial: false
    });
  });

  it("fails closed when only one half of the batch deletion contract exists", () => {
    expect(
      inspectAgentConversationBatchDeletionCapability({
        deleteSessionsBatch: vi.fn()
      })
    ).toEqual({
      available: false,
      missingMethods: ["listSessionSectionDeletionCandidates"],
      partial: true
    });
  });

  it("treats hosts without the optional capability as unavailable, not partial", () => {
    expect(inspectAgentConversationBatchDeletionCapability({})).toEqual({
      available: false,
      missingMethods: [
        "deleteSessionsBatch",
        "listSessionSectionDeletionCandidates"
      ],
      partial: false
    });
  });
});
