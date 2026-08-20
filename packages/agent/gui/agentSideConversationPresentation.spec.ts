import { describe, expect, it, vi } from "vitest";
import { createAgentGUISideConversationPresentation } from "./agentSideConversationPresentation";

describe("AgentGUI Side conversation presentation", () => {
  it("publishes and clears the exact transient projection", () => {
    const presentation = createAgentGUISideConversationPresentation();
    const listener = vi.fn();
    const identityListener = vi.fn();
    const unsubscribe = presentation.subscribe(listener);
    const unsubscribeIdentity =
      presentation.subscribeIdentity(identityListener);
    const projection = {
      close: vi.fn(async () => {}),
      sideAgentSessionId: "side-1",
      sourceAgentSessionId: "source-1",
      surfaceProps: {} as never
    };

    presentation.publish(projection);
    expect(presentation.getSnapshot()).toBe(projection);
    expect(listener).toHaveBeenCalledTimes(1);
    const identity = presentation.getIdentitySnapshot();
    expect(identity).toEqual({
      sideAgentSessionId: "side-1",
      sourceAgentSessionId: "source-1"
    });
    expect(identityListener).toHaveBeenCalledTimes(1);

    presentation.publish(projection);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(identityListener).toHaveBeenCalledTimes(1);

    presentation.publish({ ...projection, surfaceProps: {} as never });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(identityListener).toHaveBeenCalledTimes(1);
    expect(presentation.getIdentitySnapshot()).toBe(identity);

    presentation.publish(null);
    expect(presentation.getSnapshot()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(3);
    expect(identityListener).toHaveBeenCalledTimes(2);

    unsubscribe();
    unsubscribeIdentity();
    presentation.publish(projection);
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("commits projection and identity atomically across reentrant publication", () => {
    const presentation = createAgentGUISideConversationPresentation();
    const first = {
      close: vi.fn(async () => {}),
      sideAgentSessionId: "side-1",
      sourceAgentSessionId: "source-1",
      surfaceProps: {} as never
    };
    const second = {
      ...first,
      sideAgentSessionId: "side-2"
    };
    const observed: string[] = [];
    presentation.subscribe(() => {
      const projection = presentation.getSnapshot();
      const identity = presentation.getIdentitySnapshot();
      observed.push(
        `${projection?.sideAgentSessionId}:${identity?.sideAgentSessionId}`
      );
      if (projection === first) presentation.publish(second);
    });

    presentation.publish(first);

    expect(observed).toEqual(["side-1:side-1", "side-2:side-2"]);
    expect(presentation.getSnapshot()).toBe(second);
    expect(presentation.getIdentitySnapshot()?.sideAgentSessionId).toBe(
      "side-2"
    );
  });
});
