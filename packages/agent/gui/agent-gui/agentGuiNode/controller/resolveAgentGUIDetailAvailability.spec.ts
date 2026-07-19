import { describe, expect, it } from "vitest";
import { resolveAgentGUIDetailAvailability } from "./resolveAgentGUIDetailAvailability";

describe("resolveAgentGUIDetailAvailability", () => {
  it("keeps creating sessions available instead of not_found", () => {
    expect(
      resolveAgentGUIDetailAvailability({
        activeConversationId: "session-1",
        detailError: null,
        isLoadingMessages: false,
        sessionAvailability: "creating"
      })
    ).toBe("ready");
  });

  it("maps deleted and missing to not_found", () => {
    expect(
      resolveAgentGUIDetailAvailability({
        activeConversationId: "session-1",
        detailError: null,
        isLoadingMessages: false,
        sessionAvailability: "deleted"
      })
    ).toBe("not_found");
    expect(
      resolveAgentGUIDetailAvailability({
        activeConversationId: "session-1",
        detailError: null,
        isLoadingMessages: false,
        sessionAvailability: "missing"
      })
    ).toBe("not_found");
  });

  it("keeps GUI loading and detail-error presentation on available sessions", () => {
    expect(
      resolveAgentGUIDetailAvailability({
        activeConversationId: "session-1",
        detailError: null,
        isLoadingMessages: true,
        sessionAvailability: "available"
      })
    ).toBe("loading");
    expect(
      resolveAgentGUIDetailAvailability({
        activeConversationId: "session-1",
        detailError: "detail failed",
        isLoadingMessages: false,
        sessionAvailability: "available"
      })
    ).toBe("error");
  });

  it("maps failed lifecycle to error without requiring a detail transport error", () => {
    expect(
      resolveAgentGUIDetailAvailability({
        activeConversationId: "session-1",
        detailError: null,
        isLoadingMessages: false,
        sessionAvailability: "failed"
      })
    ).toBe("error");
  });
});
