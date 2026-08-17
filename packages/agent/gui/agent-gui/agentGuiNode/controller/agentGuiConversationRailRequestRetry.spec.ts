import { describe, expect, it } from "vitest";
import { conversationRailRetryMode } from "./agentGuiConversationRailRequestRetry";

describe("conversationRailRetryMode", () => {
  it("retries transient upstream failures even when an adapter defaulted retryable to false", () => {
    expect(
      conversationRailRetryMode(
        Object.assign(new Error("upstream unavailable"), {
          retryable: false,
          status: 520
        })
      )
    ).toBe("foreground");
  });

  it("does not retry authorization, parameter, or cancellation failures", () => {
    expect(conversationRailRetryMode({ status: 400 })).toBeNull();
    expect(conversationRailRetryMode({ statusCode: 403 })).toBeNull();
    expect(
      conversationRailRetryMode({
        code: "common.invalid_input",
        name: "TshAppError"
      })
    ).toBeNull();
    expect(
      conversationRailRetryMode({ code: "control_surface.unauthorized" })
    ).toBeNull();
    expect(conversationRailRetryMode({ name: "AbortError" })).toBeNull();
    expect(conversationRailRetryMode(new Error("mapper failed"))).toBeNull();
  });

  it("retries only errors with explicit transport or retryable evidence", () => {
    expect(conversationRailRetryMode(new TypeError("fetch failed"))).toBe(
      "foreground"
    );
    expect(conversationRailRetryMode({ retryable: true })).toBe("foreground");
  });

  it("defers a second request after the first request timed out", () => {
    expect(conversationRailRetryMode({ name: "TimeoutError" })).toBe(
      "background"
    );
    expect(conversationRailRetryMode({ status: 504 })).toBe("background");
  });
});
