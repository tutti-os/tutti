import { describe, expect, it } from "vitest";
import {
  clearFailedAgentGUIActivationSelection,
  shouldMarkActiveConversationRead
} from "./useAgentGUIConversationSelectionController";

describe("clearFailedAgentGUIActivationSelection", () => {
  it("does not clear a newer external selection", () => {
    const current = {
      lastActiveAgentSessionId: "session-newer",
      provider: "codex" as const
    };

    expect(
      clearFailedAgentGUIActivationSelection(current, "session-failed")
    ).toBe(current);
    expect(
      clearFailedAgentGUIActivationSelection(current, "session-newer")
        .lastActiveAgentSessionId
    ).toBeNull();
  });
});

describe("shouldMarkActiveConversationRead", () => {
  const record = {
    completionKey: "turn:session-1:turn-1:completed",
    isUnread: true,
    kind: "completed" as const,
    markedUnreadByUser: false
  };

  it("keeps a manually marked unread completion unread in the current selection", () => {
    expect(
      shouldMarkActiveConversationRead({
        activeConversationId: "session-1",
        previousActiveConversationId: "session-1",
        record: { ...record, markedUnreadByUser: true }
      })
    ).toBe(false);
  });

  it("marks manual unread as read after the session is selected again", () => {
    expect(
      shouldMarkActiveConversationRead({
        activeConversationId: "session-1",
        previousActiveConversationId: "session-2",
        record: { ...record, markedUnreadByUser: true }
      })
    ).toBe(true);
  });

  it("still marks live or hydrated unread attention as read while selected", () => {
    expect(
      shouldMarkActiveConversationRead({
        activeConversationId: "session-1",
        previousActiveConversationId: "session-1",
        record
      })
    ).toBe(true);
  });
});
