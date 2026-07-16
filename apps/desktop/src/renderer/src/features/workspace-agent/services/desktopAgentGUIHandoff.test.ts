import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_SESSION_ENGINE_LOCAL_ORIGIN,
  createAgentSessionEngine,
  type AgentActivityStartAgentCollaborationInput,
  type AgentSessionEngine,
  type EngineCommandPort
} from "@tutti-os/agent-activity-core";
import type { AgentActivityRuntime } from "@tutti-os/agent-gui";
import { startDesktopAgentGUIHandoff } from "./desktopAgentGUIHandoff.ts";

test("desktop Agent GUI creates a durable handoff before opening the target Session", async () => {
  const calls: string[] = [];
  const requests: AgentActivityStartAgentCollaborationInput[] = [];
  const opened: string[] = [];
  const agentActivityRuntime = collaborationRuntime({
    async execute(command) {
      if (command.type === "collaboration/start") {
        calls.push("handoff");
        requests.push(command.input);
        return {
          adoption: "not_applicable" as const,
          attempt: 1,
          id: "run-1",
          mode: "handoff" as const,
          sourceSessionId: "source-1",
          status: "running" as const,
          targetAgentTargetId: "workspace-agent:target",
          targetSessionId: "target-1",
          triggerSource: "user" as const,
          workspaceId: "workspace-1"
        };
      }
      return { ok: true };
    }
  });

  await startDesktopAgentGUIHandoff({
    agentActivityRuntime,
    question: "Continue the source conversation.",
    sourceAgentSessionId: "source-1",
    targetAgentTargetId: "workspace-agent:target",
    workspaceId: "workspace-1",
    async openTargetSession(agentSessionId) {
      calls.push("open");
      opened.push(agentSessionId);
    }
  });

  assert.deepEqual(requests, [
    {
      agentSessionId: "source-1",
      contextScope: "recent",
      contextText: null,
      mode: "handoff",
      question: "Continue the source conversation.",
      targetAgentTargetId: "workspace-agent:target",
      triggerReason: "handoff_menu",
      workspaceId: "workspace-1"
    }
  ]);
  assert.deepEqual(opened, ["target-1"]);
  assert.deepEqual(calls, ["handoff", "open"]);
});

test("desktop Agent GUI keeps the source visible when target launch fails", async () => {
  let opened = false;
  const agentActivityRuntime = collaborationRuntime({
    async execute(command) {
      if (command.type === "collaboration/start") {
        return {
          adoption: "not_applicable" as const,
          attempt: 1,
          failureReason: "target unavailable",
          id: "run-1",
          mode: "handoff" as const,
          status: "failed" as const,
          targetSessionId: null,
          triggerSource: "user" as const,
          workspaceId: "workspace-1"
        };
      }
      return { ok: true };
    }
  });

  await assert.rejects(
    startDesktopAgentGUIHandoff({
      agentActivityRuntime,
      question: "Continue the source conversation.",
      sourceAgentSessionId: "source-1",
      targetAgentTargetId: "workspace-agent:target",
      workspaceId: "workspace-1",
      async openTargetSession() {
        opened = true;
      }
    }),
    /target unavailable/
  );
  assert.equal(opened, false);
});

function collaborationRuntime(
  commandPort: EngineCommandPort
): AgentActivityRuntime {
  const engine = createTestEngine(commandPort);
  return {
    collaborationCommandSupport: true,
    getSessionEngine: () => engine
  } as unknown as AgentActivityRuntime;
}

function createTestEngine(commandPort: EngineCommandPort): AgentSessionEngine {
  const engine = createAgentSessionEngine({
    clock: { nowUnixMs: () => Date.now() },
    commandPort,
    identity: {
      origin: AGENT_SESSION_ENGINE_LOCAL_ORIGIN,
      workspaceId: "workspace-1"
    },
    scheduler: {
      schedule(delayMs, task) {
        const timer = setTimeout(task, delayMs);
        return { cancel: () => clearTimeout(timer) };
      }
    }
  });
  engine.dispatch({
    type: "workspace/reconcileRequested",
    workspaceId: "workspace-1"
  });
  return engine;
}
