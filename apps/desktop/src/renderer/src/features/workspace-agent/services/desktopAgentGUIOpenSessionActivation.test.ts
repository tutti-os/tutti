import assert from "node:assert/strict";
import test from "node:test";
import type { AgentActivityRuntime } from "@tutti-os/agent-gui";
import {
  consumeDesktopAgentGUIOpenSessionActivation,
  resolveDesktopAgentGUIOpenSessionActivation
} from "./desktopAgentGUIOpenSessionActivation.ts";
import { desktopAgentGUIOpenSessionActivationType } from "../desktopAgentGUINodeState.ts";
import type {
  DesktopAgentGUINodeState,
  DesktopAgentGUIWorkbenchState
} from "../desktopAgentGUINodeState.ts";

test("resolveDesktopAgentGUIOpenSessionActivation extracts valid open-session requests", () => {
  assert.deepEqual(
    resolveDesktopAgentGUIOpenSessionActivation({
      payload: { agentSessionId: " session-1 " },
      sequence: 7,
      type: desktopAgentGUIOpenSessionActivationType
    }),
    {
      agentSessionId: "session-1",
      sequence: 7
    }
  );

  assert.equal(
    resolveDesktopAgentGUIOpenSessionActivation({
      payload: { agentSessionId: "" },
      sequence: 8,
      type: desktopAgentGUIOpenSessionActivationType
    }),
    null
  );
});

test("consumeDesktopAgentGUIOpenSessionActivation activates and selects the requested session once", async () => {
  const activated: unknown[] = [];
  const cleared: unknown[] = [];
  const handled: number[] = [];
  const openSessionRequests: unknown[] = [];
  const stateChanges: DesktopAgentGUIWorkbenchState[] = [];
  let nodeState: DesktopAgentGUINodeState = {
    provider: "codex",
    lastActiveAgentSessionId: "session-1"
  };
  const agentActivityRuntime = {
    async activateSession(input: unknown) {
      activated.push(input);
      return {};
    }
  } as unknown as Pick<AgentActivityRuntime, "activateSession">;

  const consumed = consumeDesktopAgentGUIOpenSessionActivation({
    activation: {
      payload: { agentSessionId: "session-2" },
      sequence: 11,
      type: desktopAgentGUIOpenSessionActivationType
    },
    agentActivityRuntime,
    clearNodeActivation: (nodeId, sequence) => {
      cleared.push({ nodeId, sequence });
    },
    handledSequence: null,
    markHandled: (sequence) => {
      handled.push(sequence);
    },
    nodeId: "node-1",
    onOpenSessionRequest: (request) => {
      openSessionRequests.push(request);
    },
    onStateChange: (state) => {
      stateChanges.push(state);
    },
    provider: "codex",
    workspaceId: "workspace-1",
    updateNodeState: (updater) => {
      nodeState = updater(nodeState);
    }
  });

  await Promise.resolve();

  assert.equal(consumed, true);
  assert.deepEqual(handled, [11]);
  assert.deepEqual(cleared, [{ nodeId: "node-1", sequence: 11 }]);
  assert.deepEqual(openSessionRequests, [
    {
      agentSessionId: "session-2",
      sequence: 11
    }
  ]);
  assert.deepEqual(activated, [
    {
      workspaceId: "workspace-1",
      agentSessionId: "session-2",
      mode: "existing"
    }
  ]);
  assert.equal(nodeState.lastActiveAgentSessionId, "session-2");
  assert.deepEqual(stateChanges, [
    {
      conversationRailCollapsed: false,
      conversationRailWidthPx: null,
      lastActiveAgentSessionId: "session-2"
    }
  ]);

  const replayed = consumeDesktopAgentGUIOpenSessionActivation({
    activation: {
      payload: { agentSessionId: "session-2" },
      sequence: 11,
      type: desktopAgentGUIOpenSessionActivationType
    },
    agentActivityRuntime,
    handledSequence: 11,
    markHandled: (sequence) => {
      handled.push(sequence);
    },
    nodeId: "node-1",
    onStateChange: () => {},
    provider: "codex",
    workspaceId: "workspace-1",
    updateNodeState: (updater) => {
      nodeState = updater(nodeState);
    }
  });

  assert.equal(replayed, false);
  assert.deepEqual(handled, [11]);
  assert.deepEqual(activated, [
    {
      workspaceId: "workspace-1",
      agentSessionId: "session-2",
      mode: "existing"
    }
  ]);
  assert.deepEqual(openSessionRequests, [
    {
      agentSessionId: "session-2",
      sequence: 11
    }
  ]);
});

test("consumeDesktopAgentGUIOpenSessionActivation reports activation errors after selecting the session", async () => {
  const error = new Error("session not found");
  const activationErrors: unknown[] = [];
  const openSessionRequests: unknown[] = [];
  let nodeState: DesktopAgentGUINodeState = {
    provider: "codex",
    lastActiveAgentSessionId: "session-1"
  };
  const agentActivityRuntime = {
    async activateSession() {
      throw error;
    }
  } as unknown as Pick<AgentActivityRuntime, "activateSession">;

  const consumed = consumeDesktopAgentGUIOpenSessionActivation({
    activation: {
      payload: { agentSessionId: "missing-session" },
      sequence: 12,
      type: desktopAgentGUIOpenSessionActivationType
    },
    agentActivityRuntime,
    handledSequence: null,
    markHandled: () => {},
    nodeId: "node-1",
    onActivationError: (input) => {
      activationErrors.push(input);
    },
    onOpenSessionRequest: (request) => {
      openSessionRequests.push(request);
    },
    onStateChange: () => {},
    provider: "codex",
    workspaceId: "workspace-1",
    updateNodeState: (updater) => {
      nodeState = updater(nodeState);
    }
  });

  await Promise.resolve();

  assert.equal(consumed, true);
  assert.deepEqual(openSessionRequests, [
    {
      agentSessionId: "missing-session",
      sequence: 12
    }
  ]);
  assert.equal(nodeState.lastActiveAgentSessionId, "missing-session");
  assert.deepEqual(activationErrors, [
    {
      agentSessionId: "missing-session",
      error
    }
  ]);
});
