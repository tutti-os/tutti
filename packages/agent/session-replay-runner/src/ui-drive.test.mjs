import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertValidUiCheckpointName,
  loadUiScenario,
  recordUiCheckpointScreenshot,
  runUiDriveScenario
} from "./ui-drive.mjs";
import {
  managedReplayCheckpointPrefix,
  managedReplayCompletePrefix,
  managedReplayFailedPrefix
} from "./managed-log-prefixes.mjs";

test("assertValidUiCheckpointName rejects invalid names", () => {
  assert.throws(
    () => assertValidUiCheckpointName("Bad_Name"),
    /invalid ui checkpoint/
  );
  assertValidUiCheckpointName("ready");
});

test("loadUiScenario validates kind=ui contract", async () => {
  const root = await mkdtemp(join(tmpdir(), "ui-drive-load-"));
  try {
    const scenarioFile = join(root, "scenario.mjs");
    await writeFile(
      scenarioFile,
      `export default {
  id: "demo",
  kind: "ui",
  async prepare() { return { ok: true }; },
  async drive() {},
  async assert() {}
};\n`
    );
    const scenario = await loadUiScenario({
      scenario: "demo",
      scenarioFile
    });
    assert.equal(scenario.id, "demo");
    await assert.rejects(
      () => loadUiScenario({ scenario: "other", scenarioFile }),
      /does not export ui scenario other/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runUiDriveScenario drives checkpoints through ports", async () => {
  const root = await mkdtemp(join(tmpdir(), "ui-drive-run-"));
  const artifactDirectory = join(root, "artifacts");
  const scenarioFile = join(root, "scenario.mjs");
  await writeFile(
    scenarioFile,
    `export default {
  id: "demo",
  kind: "ui",
  plannedCheckpoints: 1,
  async prepare() { return { prepared: true }; },
  async drive({ checkpoint }) {
    await checkpoint("ready");
  },
  async assert({ phase }) {
    if (phase !== "terminal") throw new Error("expected terminal");
  }
};\n`
  );

  const client = { id: "client" };
  let cleaned = false;
  const stderrChunks = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => {
    stderrChunks.push(String(chunk));
    return originalWrite.call(process.stderr, chunk, ...rest);
  };

  try {
    const result = await runUiDriveScenario(
      {
        artifactDirectory,
        cassetteId: "demo_ui",
        scenario: "demo",
        scenarioFile,
        stallTimeoutMs: 12_000
      },
      {
        prefixes: {
          ready: "",
          complete: managedReplayCompletePrefix,
          failed: managedReplayFailedPrefix,
          checkpoint: managedReplayCheckpointPrefix
        },
        emitReady() {},
        async prepare({ scenario }) {
          return {
            scenarioState: await scenario.prepare({}),
            runtime: { directory: root },
            composerDefaultsMissing: false
          };
        },
        async launch() {
          return {
            getClient: () => client,
            surface: "agent-gui"
          };
        },
        async buildDriveContext({ checkpoint, prepared }) {
          return {
            checkpoint,
            scenarioState: prepared.scenarioState,
            client
          };
        },
        async captureScreenshot(_client, outputPath) {
          await writeFile(outputPath, "png");
        },
        async cleanup() {
          cleaned = true;
        }
      }
    );

    assert.equal(result.cassetteId, "demo_ui");
    assert.equal(result.checkpoints.length, 1);
    assert.equal(result.checkpoints[0].name, "ready");
    const plan = JSON.parse(
      await readFile(
        join(artifactDirectory, "demo_ui", "ui-checkpoint-plan.json"),
        "utf8"
      )
    );
    assert.equal(plan.kind, "ui-drive");
    assert.equal(plan.checkpoints[0].name, "ready");
    assert.equal(cleaned, true);
    assert.ok(
      stderrChunks.some((chunk) => chunk.includes(managedReplayCompletePrefix))
    );
    assert.equal(
      process.env.TUTTI_AGENT_SESSION_REPLAY_STALL_TIMEOUT_MS,
      undefined
    );
  } finally {
    process.stderr.write = originalWrite;
    await rm(root, { recursive: true, force: true });
  }
});

test("recordUiCheckpointScreenshot writes ordered paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "ui-drive-shot-"));
  try {
    const checkpoints = [];
    const recorded = await recordUiCheckpointScreenshot({
      artifactDirectory: root,
      cassetteId: "c1",
      client: {},
      name: "first",
      checkpoints,
      async captureScreenshot(_client, outputPath) {
        await writeFile(outputPath, "x");
      }
    });
    assert.equal(recorded.id, "checkpoint-0001");
    assert.equal(checkpoints.length, 1);
    assert.equal(recorded.path, join(root, "c1", "checkpoint-0001.png"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runUiDriveScenario fails closed when composer defaults missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "ui-drive-composer-"));
  const scenarioFile = join(root, "scenario.mjs");
  await writeFile(
    scenarioFile,
    `export default {
  id: "demo",
  kind: "ui",
  async prepare() {},
  async drive() {},
  async assert() {}
};\n`
  );
  await assert.rejects(
    () =>
      runUiDriveScenario(
        {
          artifactDirectory: join(root, "out"),
          cassetteId: "demo_ui",
          scenario: "demo",
          scenarioFile
        },
        {
          emitReady() {},
          async prepare() {
            return { composerDefaultsMissing: true };
          },
          async launch() {
            return { getClient: () => ({}) };
          },
          async buildDriveContext() {
            return {};
          },
          async captureScreenshot() {}
        }
      ),
    /did not set composer defaults/
  );
  await rm(root, { recursive: true, force: true });
});
