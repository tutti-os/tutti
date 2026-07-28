import assert from "node:assert/strict";
import test from "node:test";
import type {
  SessionAcknowledgeForkObservedCommand,
  TuttiModeActivationUpdateCommand
} from "@tutti-os/agent-activity-core";
import {
  executeWorkspaceAgentForkObservedAckCommand,
  executeWorkspaceAgentTuttiModeUpdateCommand
} from "./workspaceAgentSessionEngineHost.ts";

test("fork observation ACK forwards the durable operation identity and abort signal", async () => {
  const controller = new AbortController();
  const calls: unknown[] = [];
  const command = {
    commandId: "ack-command",
    correlationId: "local-mutation",
    operationId: "durable-operation",
    timeoutMs: 10_000,
    type: "session/ackForkObserved",
    workspaceId: "workspace-1"
  } satisfies SessionAcknowledgeForkObservedCommand;

  await executeWorkspaceAgentForkObservedAckCommand(
    {
      async acknowledgeWorkspaceAgentSessionForkOperation(
        workspaceId,
        operationId,
        options
      ) {
        calls.push({ operationId, options, workspaceId });
        return { acknowledged: true };
      }
    },
    command,
    controller.signal
  );

  assert.deepEqual(calls, [
    {
      operationId: "durable-operation",
      options: { signal: controller.signal },
      workspaceId: "workspace-1"
    }
  ]);
});

test("Tutti mode update command preserves CAS revision and zero intensity", async () => {
  const controller = new AbortController();
  let received: unknown;
  await executeWorkspaceAgentTuttiModeUpdateCommand(
    {
      updateTuttiModeActivation: async (input) => {
        received = input;
        return {} as never;
      }
    },
    {
      agentSessionId: "session-1",
      commandId: "tutti-1",
      expectedRevision: 3,
      orchestrationIntensity: 0,
      source: "slash_command",
      status: "active",
      type: "tuttiMode/update",
      workspaceId: "workspace-1"
    } satisfies TuttiModeActivationUpdateCommand,
    controller.signal
  );

  assert.deepEqual(received, {
    agentSessionId: "session-1",
    expectedRevision: 3,
    orchestrationIntensity: 0,
    signal: controller.signal,
    source: "slash_command",
    status: "active",
    workspaceId: "workspace-1"
  });
});
