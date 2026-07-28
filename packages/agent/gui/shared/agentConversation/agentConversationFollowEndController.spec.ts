import { describe, expect, it } from "vitest";
import { createAgentConversationFollowEndController } from "./agentConversationFollowEndController";

describe("createAgentConversationFollowEndController", () => {
  it("starts by following the conversation end", () => {
    const controller = createAgentConversationFollowEndController();

    expect(controller.getSnapshot()).toBe("following");
  });

  it("keeps scroll-away intent until an explicit follow event", () => {
    const controller = createAgentConversationFollowEndController();

    controller.dispatch("user-scrolled-away");
    expect(controller.getSnapshot()).toBe("detached");

    controller.dispatch("user-reached-end");
    expect(controller.getSnapshot()).toBe("following");
  });

  it.each([
    "conversation-changed",
    "prompt-submitted",
    "scroll-to-end-requested"
  ] as const)("reattaches for %s", (event) => {
    const controller = createAgentConversationFollowEndController();
    controller.dispatch("user-scrolled-away");

    controller.dispatch(event);

    expect(controller.getSnapshot()).toBe("following");
  });

  it("returns the resulting mode to UI adapters", () => {
    const controller = createAgentConversationFollowEndController();

    expect(controller.dispatch("user-scrolled-away")).toBe("detached");
    expect(controller.dispatch("user-reached-end")).toBe("following");
  });
});
