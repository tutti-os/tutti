import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createAgentSessionReplayControlWriter,
  readAgentSessionReplayStatus
} from "./agentSessionReplayStatus.ts";

test("reads isolated replay status", async () => {
  const directory = await mkdtemp(join(tmpdir(), "replay-status-"));
  const path = join(directory, "status.json");
  await writeFile(
    path,
    JSON.stringify({
      currentCheckpoint: 2,
      errorMessage: "expected state mismatch",
      paused: true,
      phase: "failed",
      targetCheckpoint: null,
      timingMode: "fast-forward",
      totalCheckpoints: 4
    })
  );
  await writeFile(
    join(directory, "replay-catalog.json"),
    JSON.stringify({
      cassetteId: "cassette-1",
      cassettes: [
        { id: "cassette-1", name: "First" },
        { id: "cassette-2", name: "Second" }
      ]
    })
  );

  assert.deepEqual(await readAgentSessionReplayStatus(path), {
    active: true,
    cassetteId: "cassette-1",
    cassettes: [
      { id: "cassette-1", name: "First" },
      { id: "cassette-2", name: "Second" }
    ],
    currentCheckpoint: 2,
    errorMessage: "expected state mismatch",
    paused: true,
    phase: "failed",
    targetCheckpoint: null,
    timingMode: "fast-forward",
    totalCheckpoints: 4
  });
});

test("hides absent or invalid replay status", async () => {
  assert.deepEqual(await readAgentSessionReplayStatus(""), { active: false });
  assert.deepEqual(await readAgentSessionReplayStatus("/missing/status.json"), {
    active: false
  });
});

test("writes replay controls atomically with increasing revisions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "replay-control-"));
  const path = join(directory, "replay-control.json");
  const writeControl = createAgentSessionReplayControlWriter(path);

  await Promise.all([
    writeControl({ command: "next-checkpoint" }),
    writeControl({ command: "previous-checkpoint" }),
    writeControl({ command: "restart" }),
    writeControl({ command: "switch-cassette", cassetteId: "cassette-2" })
  ]);

  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
    schemaVersion: 1,
    revision: 4,
    command: "switch-cassette",
    cassetteId: "cassette-2"
  });
});
