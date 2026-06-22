import { afterEach, describe, expect, it } from "vitest";
import {
  clearConversationCreationOwner,
  clearFailedNewConversation,
  getStartingConversationId,
  isActivatedConversation,
  isFailedNewConversation,
  markActivatedConversation,
  markFailedNewConversation,
  resetConversationCreationStoreForTests,
  setStartingConversationId,
  unmarkActivatedConversation
} from "./agentGuiConversationCreationStore.ts";

afterEach(() => {
  resetConversationCreationStoreForTests();
});

describe("agentGuiConversationCreationStore", () => {
  it("tracks the starting conversation id per owner", () => {
    expect(getStartingConversationId("owner-a")).toBeNull();
    setStartingConversationId("owner-a", "conv-1");
    expect(getStartingConversationId("owner-a")).toBe("conv-1");
    // Owners are isolated from one another.
    expect(getStartingConversationId("owner-b")).toBeNull();
    setStartingConversationId("owner-a", null);
    expect(getStartingConversationId("owner-a")).toBeNull();
  });

  it("tracks activated conversations per owner", () => {
    expect(isActivatedConversation("owner-a", "conv-1")).toBe(false);
    markActivatedConversation("owner-a", "conv-1");
    expect(isActivatedConversation("owner-a", "conv-1")).toBe(true);
    expect(isActivatedConversation("owner-b", "conv-1")).toBe(false);
    unmarkActivatedConversation("owner-a", "conv-1");
    expect(isActivatedConversation("owner-a", "conv-1")).toBe(false);
  });

  it("tracks failed new conversations per owner", () => {
    expect(isFailedNewConversation("owner-a", "conv-1")).toBe(false);
    markFailedNewConversation("owner-a", "conv-1");
    expect(isFailedNewConversation("owner-a", "conv-1")).toBe(true);
    clearFailedNewConversation("owner-a", "conv-1");
    expect(isFailedNewConversation("owner-a", "conv-1")).toBe(false);
  });

  it("clears all bookkeeping for an owner on unmount", () => {
    setStartingConversationId("owner-a", "conv-1");
    markActivatedConversation("owner-a", "conv-2");
    markFailedNewConversation("owner-a", "conv-3");

    clearConversationCreationOwner("owner-a");

    expect(getStartingConversationId("owner-a")).toBeNull();
    expect(isActivatedConversation("owner-a", "conv-2")).toBe(false);
    expect(isFailedNewConversation("owner-a", "conv-3")).toBe(false);
  });

  it("ignores clears for unknown ids and owners", () => {
    // Should not throw when the owner has no state yet.
    clearFailedNewConversation("missing", "conv-1");
    unmarkActivatedConversation("missing", "conv-1");
    setStartingConversationId("missing-null", null);
    expect(getStartingConversationId("missing-null")).toBeNull();
  });
});
