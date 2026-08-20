import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSessionEngine } from "@tutti-os/agent-activity-core";
import type { AgentGUIRuntime } from "@tutti-os/agent-gui";
import {
  consumeDesktopAgentGUIOpenSessionActivation,
  resolveDesktopAgentGUIOpenSessionActivation
} from "./desktopAgentGUIOpenSessionActivation.ts";
import { desktopAgentGUIOpenSessionActivationType } from "../desktopAgentGUINodeState.ts";
import type {
  DesktopAgentGUINodeState,
  DesktopAgentGUIWorkbenchState
} from "../desktopAgentGUINodeState.ts";

function agentActivityRuntimeWithActivation(
  activateSession: AgentSessionEngine["activateSession"],
  onWorkspace?: (workspaceId: string) => void
): Pick<AgentGUIRuntime, "getSessionEngine"> {
  return {
    getSessionEngine(workspaceId) {
      onWorkspace?.(workspaceId);
      return {
        activateSession,
        getSnapshot: () => ({ sessionLifecycle: { sessionsById: {} } })
      } as unknown as AgentSessionEngine;
    }
  };
}

test("resolveDesktopAgentGUIOpenSessionActivation extracts valid open-session requests", () => {
  assert.deepEqual(
    resolveDesktopAgentGUIOpenSessionActivation({
      payload: {
        agentSessionId: " session-1 ",
        agentTargetId: " local:claude-code ",
        provider: "claude-code"
      },
      sequence: 7,
      type: desktopAgentGUIOpenSessionActivationType
    }),
    {
      agentSessionId: "session-1",
      agentTargetId: "local:claude-code",
      provider: "claude-code",
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

test("consumeDesktopAgentGUIOpenSessionActivation admits and forwards an exact cross-Agent session once", () => {
  const activated: unknown[] = [];
  const engineWorkspaceIds: string[] = [];
  const cleared: unknown[] = [];
  const handled: number[] = [];
  const openSessionRequests: unknown[] = [];
  const stateChanges: DesktopAgentGUIWorkbenchState[] = [];
  let nodeState: DesktopAgentGUINodeState = {
    provider: "codex",
    lastActiveAgentSessionId: "session-1"
  };
  const agentActivityRuntime = agentActivityRuntimeWithActivation(
    (input) => {
      activated.push(input);
      return true;
    },
    (workspaceId) => {
      engineWorkspaceIds.push(workspaceId);
    }
  );

  const consumed = consumeDesktopAgentGUIOpenSessionActivation({
    activation: {
      payload: {
        agentSessionId: "session-2",
        agentTargetId: "local:claude-code",
        provider: "claude-code"
      },
      sequence: 11,
      type: desktopAgentGUIOpenSessionActivationType
    },
    agentActivityRuntime,
    agentDirectoryStatus: "ready",
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
    resolveAgentTargetProvider: (agentTargetId) =>
      agentTargetId === "local:claude-code" ? "claude-code" : null,
    workspaceId: "workspace-1",
    updateNodeState: (updater) => {
      nodeState = updater(nodeState);
    }
  });

  assert.equal(consumed, true);
  assert.deepEqual(handled, [11]);
  assert.deepEqual(cleared, [{ nodeId: "node-1", sequence: 11 }]);
  assert.deepEqual(openSessionRequests, [
    {
      agentSessionId: "session-2",
      agentTargetId: "local:claude-code",
      provider: "claude-code",
      sequence: 11
    }
  ]);
  assert.deepEqual(activated, [
    {
      agentSessionId: "session-2",
      mode: "existing",
      requestId: "workbench-open-session:workspace-1:node-1:session-2:11"
    }
  ]);
  assert.deepEqual(engineWorkspaceIds, ["workspace-1"]);
  assert.equal(nodeState.agentTargetId, undefined);
  assert.equal(nodeState.lastActiveAgentSessionId, "session-1");
  assert.equal(nodeState.provider, "codex");
  assert.deepEqual(stateChanges, []);

  const replayed = consumeDesktopAgentGUIOpenSessionActivation({
    activation: {
      payload: { agentSessionId: "session-2" },
      sequence: 11,
      type: desktopAgentGUIOpenSessionActivationType
    },
    agentActivityRuntime,
    agentDirectoryStatus: "ready",
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
      agentSessionId: "session-2",
      mode: "existing",
      requestId: "workbench-open-session:workspace-1:node-1:session-2:11"
    }
  ]);
  assert.deepEqual(engineWorkspaceIds, ["workspace-1"]);
  assert.deepEqual(openSessionRequests, [
    {
      agentSessionId: "session-2",
      agentTargetId: "local:claude-code",
      provider: "claude-code",
      sequence: 11
    }
  ]);
});

test("consumeDesktopAgentGUIOpenSessionActivation clears stale cross-provider targets", () => {
  let nodeState: DesktopAgentGUINodeState = {
    agentTargetId: "local:claude-code",
    provider: "claude-code",
    lastActiveAgentSessionId: "session-claude-1"
  };
  const agentActivityRuntime = agentActivityRuntimeWithActivation(() => true);

  const consumed = consumeDesktopAgentGUIOpenSessionActivation({
    activation: {
      payload: { agentSessionId: "session-codex-1" },
      sequence: 12,
      type: desktopAgentGUIOpenSessionActivationType
    },
    agentActivityRuntime,
    agentDirectoryStatus: "ready",
    handledSequence: null,
    markHandled: () => {},
    nodeId: "node-1",
    onStateChange: () => {},
    provider: "codex",
    resolveAgentTargetProvider: (agentTargetId) =>
      agentTargetId === "local:claude-code" ? "claude-code" : null,
    workspaceId: "workspace-1",
    updateNodeState: (updater) => {
      nodeState = updater(nodeState);
    }
  });

  assert.equal(consumed, true);
  assert.equal(nodeState.lastActiveAgentSessionId, "session-codex-1");
  assert.equal(nodeState.provider, "codex");
  assert.equal(nodeState.agentTargetId, null);
});

test("consumeDesktopAgentGUIOpenSessionActivation leaves state untouched when admission rejects", () => {
  const activated: unknown[] = [];
  const openSessionRequests: unknown[] = [];
  const rejections: unknown[] = [];
  let nodeState: DesktopAgentGUINodeState = {
    provider: "codex",
    lastActiveAgentSessionId: "session-1"
  };
  const agentActivityRuntime = agentActivityRuntimeWithActivation((input) => {
    activated.push(input);
    return false;
  });

  const consumed = consumeDesktopAgentGUIOpenSessionActivation({
    activation: {
      payload: { agentSessionId: "missing-session" },
      sequence: 12,
      type: desktopAgentGUIOpenSessionActivationType
    },
    agentActivityRuntime,
    agentDirectoryStatus: "ready",
    handledSequence: null,
    markHandled: () => {},
    nodeId: "node-1",
    onOpenSessionRequest: (request) => {
      openSessionRequests.push(request);
    },
    onOpenSessionRejected: (request, reason) => {
      rejections.push({ request, reason });
    },
    onStateChange: () => {},
    provider: "codex",
    workspaceId: "workspace-1",
    updateNodeState: (updater) => {
      nodeState = updater(nodeState);
    }
  });

  assert.equal(consumed, false);
  assert.deepEqual(openSessionRequests, []);
  assert.equal(nodeState.lastActiveAgentSessionId, "session-1");
  assert.deepEqual(rejections, [
    {
      reason: "session-activation-rejected",
      request: {
        agentSessionId: "missing-session",
        sequence: 12
      }
    }
  ]);
  assert.deepEqual(activated, [
    {
      agentSessionId: "missing-session",
      mode: "existing",
      requestId: "workbench-open-session:workspace-1:node-1:missing-session:12"
    }
  ]);
});
