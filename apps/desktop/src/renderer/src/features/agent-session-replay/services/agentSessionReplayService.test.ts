import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSessionRecording } from "@tutti-os/client-tuttid-ts";
import { AgentSessionReplayService } from "./agentSessionReplayService.ts";

const readyRecording: AgentSessionRecording = {
  id: "recording-1",
  name: "1970-01-01T00:00:00.001Z",
  workspaceId: "workspace-1",
  agentTargetId: "local:codex",
  mode: "create-session",
  status: "ready",
  directory: "/tmp/recording-1",
  createdAtUnixMs: 1,
  updatedAtUnixMs: 1
};

test("reconciles recording truth from the daemon list", async () => {
  const service = createService({
    listAgentSessionRecordings: async () => [readyRecording]
  });

  await service.refresh();

  assert.equal(service.getSnapshot().activeRecording?.id, "recording-1");
  assert.deepEqual(service.getSnapshot().recordings, [readyRecording]);
});

test("does not emit an unchanged background refresh", async () => {
  const service = createService({
    listAgentSessionRecordings: async () => [{ ...readyRecording }]
  });
  await service.refresh();
  const loadingStates: boolean[] = [];
  const dispose = service.subscribe(() => {
    loadingStates.push(service.getSnapshot().loading);
  });

  await service.refresh({ background: true });

  dispose();
  assert.deepEqual(loadingStates, []);
});

test("arms create-session recording outside AgentGUI", async () => {
  const armed: string[] = [];
  const service = createService(
    {
      startAgentSessionRecording: async () => readyRecording
    },
    {
      armNextSessionRecording: (recordingId) => armed.push(recordingId)
    }
  );

  await service.startRecording({ agentTargetId: "local:codex" });

  assert.deepEqual(armed, ["recording-1"]);
  assert.equal(service.getSnapshot().activeRecording?.id, "recording-1");
});

test("starts, seals, and discards the renderer activity recording with the daemon recording", async () => {
  const calls: string[] = [];
  const service = createService(
    {
      startAgentSessionRecording: async () => {
        calls.push("daemon:start");
        return readyRecording;
      },
      completeAgentSessionRecording: async () => {
        calls.push("daemon:complete");
        return { ...readyRecording, status: "complete" };
      },
      cancelAgentSessionRecording: async () => {
        calls.push("daemon:cancel");
        return { ...readyRecording, status: "canceled" };
      }
    },
    {
      discardActivityEventRecording: (recordingId) =>
        calls.push(`activity:discard:${recordingId}`),
      sealActivityEventRecording: async (recordingId) => {
        calls.push(`activity:seal:${recordingId}`);
      },
      startActivityEventRecording: (recordingId) =>
        calls.push(`activity:start:${recordingId}`)
    }
  );

  await service.startRecording({
    agentSessionId: "session-1",
    agentTargetId: "local:codex"
  });
  await service.completeRecording("recording-1");
  await service.startRecording({
    agentSessionId: "session-1",
    agentTargetId: "local:codex"
  });
  await service.cancelRecording("recording-1");

  assert.deepEqual(calls, [
    "daemon:start",
    "activity:start:recording-1",
    "activity:seal:recording-1",
    "daemon:complete",
    "daemon:start",
    "activity:start:recording-1",
    "daemon:cancel",
    "activity:discard:recording-1"
  ]);
});

test("keeps the new-session binding when cancellation fails", async () => {
  const cleared: string[] = [];
  const service = createService(
    {
      cancelAgentSessionRecording: async () => {
        throw new Error("cancel failed");
      }
    },
    {
      clearNextSessionRecording: (recordingId) => {
        if (recordingId) cleared.push(recordingId);
      }
    }
  );

  await assert.rejects(service.cancelRecording("recording-1"), /cancel failed/);

  assert.deepEqual(cleared, []);
});

test("removes a canceled recording from the list", async () => {
  const service = createService({
    listAgentSessionRecordings: async () => [readyRecording]
  });
  await service.refresh();

  await service.cancelRecording(readyRecording.id);

  assert.equal(service.getSnapshot().activeRecording, null);
  assert.deepEqual(service.getSnapshot().recordings, []);
});

test("replaces recording state after a persisted cassette rename", async () => {
  const service = createService({
    listAgentSessionRecordings: async () => [
      { ...readyRecording, cassetteId: "cassette-1", status: "complete" }
    ],
    renameAgentSessionRecording: async () => ({
      ...readyRecording,
      cassetteId: "cassette-1",
      name: "checkout regression",
      status: "complete",
      updatedAtUnixMs: 2
    })
  });
  await service.refresh();

  await service.renameRecording(readyRecording.id, " checkout regression ");

  assert.equal(
    service.getSnapshot().recordings[0]?.name,
    "checkout regression"
  );
});

function createService(
  overrides: Partial<{
    cancelAgentSessionRecording(): Promise<AgentSessionRecording>;
    completeAgentSessionRecording(): Promise<AgentSessionRecording>;
    listAgentSessionRecordings(): Promise<AgentSessionRecording[]>;
    renameAgentSessionRecording(): Promise<AgentSessionRecording>;
    startAgentSessionRecording(): Promise<AgentSessionRecording>;
  }> = {},
  dependencyOverrides: Partial<{
    armNextSessionRecording(recordingId: string): void;
    clearNextSessionRecording(recordingId?: string): void;
    discardActivityEventRecording(recordingId: string): void;
    sealActivityEventRecording(recordingId: string): Promise<void>;
    startActivityEventRecording(recordingId: string): void;
  }> = {}
): AgentSessionReplayService {
  return new AgentSessionReplayService({
    armNextSessionRecording: () => {},
    clearNextSessionRecording: () => {},
    discardActivityEventRecording: () => {},
    sealActivityEventRecording: async () => {},
    startActivityEventRecording: () => {},
    tuttidClient: {
      cancelAgentSessionRecording: async () => ({
        ...readyRecording,
        status: "canceled"
      }),
      completeAgentSessionRecording: async () => ({
        ...readyRecording,
        status: "complete"
      }),
      completeAgentSessionReplayRun: async () => ({}) as never,
      failAgentSessionReplayRun: async () => ({}) as never,
      listAgentSessionRecordings: async () => [],
      markAgentSessionReplayRunRunning: async () => ({}) as never,
      prepareAgentSessionReplayRun: async () => ({}) as never,
      renameAgentSessionRecording: async () => readyRecording,
      startAgentSessionRecording: async () => readyRecording,
      ...overrides
    },
    workspaceId: "workspace-1",
    ...dependencyOverrides
  });
}
