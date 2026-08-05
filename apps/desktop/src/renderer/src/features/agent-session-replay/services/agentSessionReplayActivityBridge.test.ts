import assert from "node:assert/strict";
import test from "node:test";
import type {
  EngineExternalCommand,
  EngineIntent
} from "@tutti-os/agent-activity-core";
import type { TuttidClient } from "@tutti-os/client-tuttid-ts";
import { AgentSessionReplayActivityBridge } from "./agentSessionReplayActivityBridge.ts";

function queueRemovedIntent(): EngineIntent {
  return {
    agentSessionId: "session-1",
    promptId: "prompt-1",
    type: "queue/removed"
  };
}

function queueRemovedCommand(): EngineExternalCommand {
  return {
    agentSessionId: "session-1",
    commandId: "queue:removed:1",
    promptId: "prompt-1",
    type: "queue/removed"
  } as unknown as EngineExternalCommand;
}

function createClient(
  appended: { recordingId: string; types: string[] }[]
): TuttidClient {
  return {
    appendAgentSessionRecordingActivityEvents: async (
      _workspaceId: string,
      recordingId: string,
      body: { events: { type: string }[] }
    ) => {
      appended.push({
        recordingId,
        types: body.events.map((event) => event.type)
      });
    }
  } as unknown as TuttidClient;
}

test("replay activity bridge fans Engine activity into recording and observers", async () => {
  const appended: { recordingId: string; types: string[] }[] = [];
  const observed: { commands: string[]; intents: string[] } = {
    commands: [],
    intents: []
  };
  const bridge = new AgentSessionReplayActivityBridge({
    enabled: true,
    tuttidClient: createClient(appended)
  });
  bridge.addSessionEngineActivityObserver("ws-1", {
    observeCommand(command) {
      observed.commands.push(command.type);
    },
    observeIntent(intent) {
      observed.intents.push(intent.type);
    }
  });
  bridge.startSessionActivityEventRecording("ws-1", "recording-1");

  const activityObserver = bridge.createSessionEngineActivityObserver("ws-1");
  const intent = queueRemovedIntent();
  const command = queueRemovedCommand();
  activityObserver.observeIntent(intent);
  activityObserver.observeCommand(command);
  await bridge.sealSessionActivityEventRecording("ws-1", "recording-1");

  assert.deepEqual(observed, {
    commands: ["queue/removed"],
    intents: ["queue/removed"]
  });
  assert.deepEqual(appended, [
    { recordingId: "recording-1", types: ["queue/removed"] }
  ]);
});

test("disabled replay activity bridge fails closed without composing recording", () => {
  const bridge = new AgentSessionReplayActivityBridge({
    enabled: false,
    tuttidClient: createClient([])
  });

  assert.throws(
    () => bridge.startSessionActivityEventRecording("ws-1", "recording-1"),
    /agent_session_replay_not_composed/
  );
  assert.throws(
    () => bridge.createSessionEngineActivityObserver("ws-1"),
    /agent_session_replay_not_composed/
  );
});
