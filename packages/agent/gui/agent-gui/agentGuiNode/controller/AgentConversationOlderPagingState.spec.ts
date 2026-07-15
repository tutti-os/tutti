import { describe, expect, it } from "vitest";
import { AgentConversationOlderPagingState } from "./AgentConversationOlderPagingState";

describe("AgentConversationOlderPagingState", () => {
  it("models in-flight, terminal, and reset transitions", () => {
    const state = new AgentConversationOlderPagingState();
    const first = state.begin("session-1", 200);
    expect(first.kind).toBe("started");
    if (first.kind !== "started") return;

    expect(state.begin("session-1", 150)).toMatchObject({
      kind: "suppressed",
      entry: { beforeVersion: 200, phase: "in_flight" }
    });
    expect(state.resolve(first.request, true)).toBe(true);
    expect(state.begin("session-1", 200)).toMatchObject({
      kind: "suppressed",
      entry: { beforeVersion: 200, phase: "exhausted" }
    });
    expect(state.begin("session-1", 100)).toMatchObject({
      kind: "suppressed",
      entry: { phase: "exhausted" }
    });
    state.reset("session-1");
    expect(state.begin("session-1", 100).kind).toBe("started");
  });

  it("invalidates an older request when session paging resets", () => {
    const state = new AgentConversationOlderPagingState();
    const first = state.begin("session-1", 200);
    if (first.kind !== "started") return;

    state.reset("session-1");

    expect(state.resolve(first.request, false)).toBe(false);
    expect(state.fail(first.request)).toBe(false);
    expect(state.begin("session-1", 200).kind).toBe("started");
  });
});
