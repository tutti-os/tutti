import assert from "node:assert/strict";
import test from "node:test";
import { createAgentSessionReplayLauncher } from "./agentSessionReplayLauncher.ts";

test("launches replay through Desktop runtime without opening a terminal", async () => {
  const events: string[] = [];
  let resolveCompletion!: () => void;
  const runtimeCompletion = new Promise<void>((resolve) => {
    resolveCompletion = resolve;
  });
  const launcher = createAgentSessionReplayLauncher({
    workspaceId: "workspace-1",
    runtimeApi: {
      async launchAgentSessionReplay(input) {
        events.push(`launch:${input.runId}:${input.cassetteDirectory}`);
        return { runId: input.runId };
      },
      async waitForAgentSessionReplay(input) {
        events.push(`wait:${input.runId}`);
        await runtimeCompletion;
        return { runId: "replay-run-2" };
      }
    },
    service: {
      async prepareReplayRun(cassetteId) {
        events.push(`prepare:${cassetteId}`);
        return {
          cassetteDirectory: "/cassette/recording-1",
          run: {
            cassetteId,
            checkpoint: 0,
            createdAtUnixMs: 1,
            id: "replay-run-1",
            status: "starting" as const,
            updatedAtUnixMs: 1
          }
        };
      },
      async markReplayRunRunning(runId) {
        events.push(`running:${runId}`);
        return {} as never;
      },
      async completeReplayRun(runId) {
        events.push(`complete:${runId}`);
        return {} as never;
      },
      async failReplayRun(runId) {
        events.push(`fail:${runId}`);
        return {} as never;
      }
    }
  });

  const launched = await launcher.launch("cassette-1");

  assert.deepEqual(events, [
    "prepare:cassette-1",
    "running:replay-run-1",
    "launch:replay-run-1:/cassette/recording-1",
    "wait:replay-run-1"
  ]);

  resolveCompletion();
  await launched.completion;
  assert.deepEqual(events, [
    "prepare:cassette-1",
    "running:replay-run-1",
    "launch:replay-run-1:/cassette/recording-1",
    "wait:replay-run-1",
    "complete:replay-run-2"
  ]);
});

test("persists replay failure and never completes a failed launch", async () => {
  const events: string[] = [];
  const launcher = createAgentSessionReplayLauncher({
    workspaceId: "workspace-1",
    runtimeApi: {
      async launchAgentSessionReplay() {
        events.push("launch");
        throw new Error("cassette mismatch");
      },
      async waitForAgentSessionReplay() {
        events.push("wait");
        return { runId: "run-1" };
      }
    },
    service: {
      async prepareReplayRun() {
        events.push("prepare");
        return {
          cassetteDirectory: "/cassette",
          run: {
            cassetteId: "cassette-1",
            checkpoint: 0,
            createdAtUnixMs: 1,
            id: "run-1",
            status: "starting" as const,
            updatedAtUnixMs: 1
          }
        };
      },
      async markReplayRunRunning() {
        events.push("running");
        return {} as never;
      },
      async completeReplayRun() {
        events.push("complete");
        return {} as never;
      },
      async failReplayRun(_runId, error) {
        events.push(`failed:${error instanceof Error ? error.message : error}`);
        return {} as never;
      }
    }
  });

  await assert.rejects(launcher.launch("cassette-1"), /cassette mismatch/u);
  assert.deepEqual(events, [
    "prepare",
    "running",
    "launch",
    "failed:cassette mismatch"
  ]);
});

test("persists a replay failure that happens after the window opens", async () => {
  const events: string[] = [];
  const launcher = createAgentSessionReplayLauncher({
    workspaceId: "workspace-1",
    runtimeApi: {
      async launchAgentSessionReplay() {
        events.push("launch");
        return { runId: "run-1" };
      },
      async waitForAgentSessionReplay() {
        events.push("wait");
        throw new Error("transport mismatch");
      }
    },
    service: {
      async prepareReplayRun() {
        events.push("prepare");
        return {
          cassetteDirectory: "/cassette",
          run: {
            cassetteId: "cassette-1",
            checkpoint: 0,
            createdAtUnixMs: 1,
            id: "run-1",
            status: "starting" as const,
            updatedAtUnixMs: 1
          }
        };
      },
      async markReplayRunRunning() {
        events.push("running");
        return {} as never;
      },
      async completeReplayRun() {
        events.push("complete");
        return {} as never;
      },
      async failReplayRun(_runId, error) {
        events.push(`failed:${error instanceof Error ? error.message : error}`);
        return {} as never;
      }
    }
  });

  const launched = await launcher.launch("cassette-1");
  await assert.rejects(launched.completion, /transport mismatch/u);
  assert.deepEqual(events, [
    "prepare",
    "running",
    "launch",
    "wait",
    "failed:transport mismatch"
  ]);
});
