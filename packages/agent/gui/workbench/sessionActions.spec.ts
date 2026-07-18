import { describe, expect, it } from "vitest";
import {
  AGENT_GUI_WORKBENCH_SESSION_ACTION_EVENT,
  dispatchAgentGuiWorkbenchSessionAction,
  isAgentGuiWorkbenchSessionAction,
  type AgentGuiWorkbenchSessionActionDetail
} from "./sessionActions.ts";

describe("isAgentGuiWorkbenchSessionAction", () => {
  it.each(["rename", "copy-markdown", "copy-reference"] as const)(
    "accepts %s",
    (action) => {
      expect(isAgentGuiWorkbenchSessionAction(action)).toBe(true);
    }
  );

  it.each([
    "pin",
    "delete",
    "copy",
    "copy-working-directory",
    "copy-session-id",
    "copy-deep-link",
    "",
    42,
    null,
    undefined
  ])("rejects %s", (value) => {
    expect(isAgentGuiWorkbenchSessionAction(value)).toBe(false);
  });
});

describe("dispatchAgentGuiWorkbenchSessionAction", () => {
  it("dispatches the session action event with the detail verbatim", () => {
    const received: AgentGuiWorkbenchSessionActionDetail[] = [];
    const listener = (event: Event) => {
      received.push(
        (event as CustomEvent<AgentGuiWorkbenchSessionActionDetail>).detail
      );
    };
    window.addEventListener(AGENT_GUI_WORKBENCH_SESSION_ACTION_EVENT, listener);
    try {
      dispatchAgentGuiWorkbenchSessionAction({
        action: "copy-markdown",
        agentSessionId: "session-1",
        instanceId: "instance-1"
      });
      dispatchAgentGuiWorkbenchSessionAction({
        action: "rename",
        agentSessionId: null,
        instanceId: "instance-2"
      });
    } finally {
      window.removeEventListener(
        AGENT_GUI_WORKBENCH_SESSION_ACTION_EVENT,
        listener
      );
    }
    expect(received).toEqual([
      {
        action: "copy-markdown",
        agentSessionId: "session-1",
        instanceId: "instance-1"
      },
      { action: "rename", agentSessionId: null, instanceId: "instance-2" }
    ]);
  });
});
