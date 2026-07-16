import assert from "node:assert/strict";
import test from "node:test";
import type { AgentActivityStartAgentCollaborationInput } from "@tutti-os/agent-activity-core";
import type { AgentActivityRuntime } from "@tutti-os/agent-gui";
import { startDesktopAgentGUIHandoff } from "./desktopAgentGUIHandoff.ts";

test("desktop Agent GUI creates a durable handoff before opening the target Session", async () => {
  const calls: string[] = [];
  const requests: AgentActivityStartAgentCollaborationInput[] = [];
  const opened: string[] = [];
  const agentActivityRuntime = {
    async startAgentCollaboration(
      input: AgentActivityStartAgentCollaborationInput
    ) {
      calls.push("handoff");
      requests.push(input);
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
  } as unknown as AgentActivityRuntime;

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
  const agentActivityRuntime = {
    async startAgentCollaboration() {
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
  } as unknown as AgentActivityRuntime;

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
