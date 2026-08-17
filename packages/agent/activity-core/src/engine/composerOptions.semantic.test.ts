import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentActivityComposerOptions } from "../types.ts";
import { createAgentSessionEngine } from "./createAgentSessionEngine.ts";
import { createTestEngineCommandPort } from "./testEngineCommandPort.ts";
import type { EngineExternalCommand, EngineScheduler } from "./types.ts";

function composerOptions(
  model: string,
  overrides: Partial<AgentActivityComposerOptions> = {}
): AgentActivityComposerOptions {
  return {
    behavior: {
      collapseModelOptionsToLatest: false,
      modelOptionsAuthoritative: true,
      planModeExclusiveWithPermissionMode: false,
      prewarmDraftSession: false,
      refreshModelOptionsAfterSettings: false
    },
    capabilities: null,
    loadedAtUnixMs: 1,
    models: [{ label: model, value: model }],
    provider: "codex",
    reasoningEfforts: [],
    skills: [],
    speeds: [],
    ...overrides
  };
}

function createHarness() {
  const commands: EngineExternalCommand[] = [];
  const settlers = new Map<
    string,
    { reject(error: unknown): void; resolve(value: unknown): void }
  >();
  const commandPort = createTestEngineCommandPort((command) => {
    commands.push(command);
    return new Promise((resolve, reject) => {
      settlers.set(command.commandId, { reject, resolve });
    });
  });
  const scheduler: EngineScheduler = {
    schedule() {
      return { cancel() {} };
    }
  };
  const engine = createAgentSessionEngine({
    clock: { nowUnixMs: () => 10 },
    commandPort,
    identity: { origin: "test", workspaceId: "workspace-1" },
    scheduler
  });
  return {
    commands,
    engine,
    fail(commandId: string, error: unknown) {
      settlers.get(commandId)?.reject(error);
    },
    succeed(commandId: string, value: unknown) {
      settlers.get(commandId)?.resolve(value);
    }
  };
}

function loadInput(overrides: { cwd?: string; force?: boolean } = {}) {
  return {
    provider: "codex",
    targetKey: "target-1",
    ...overrides
  };
}

test("core settles before capabilities and section requests do not share in-flight state", async () => {
  const harness = createHarness();
  const core = harness.engine.loadComposerOptions({
    ...loadInput(),
    section: "core"
  });
  const capabilities = harness.engine.loadComposerOptions({
    ...loadInput(),
    section: "capabilities"
  });

  assert.equal(harness.commands.length, 2);
  assert.equal(harness.commands[0]?.type, "composerOptions/load");
  assert.equal(harness.commands[1]?.type, "composerOptions/load");
  assert.equal(harness.commands[0]?.section, "core");
  assert.equal(harness.commands[1]?.section, "capabilities");

  harness.succeed(
    harness.commands[0]!.commandId,
    composerOptions("core-model")
  );
  const coreOptions = await core;
  assert.equal(coreOptions.models[0]?.value, "core-model");
  assert.equal(harness.commands.length, 2);

  harness.succeed(
    harness.commands[1]!.commandId,
    composerOptions("capability-response", {
      skills: [
        {
          name: "search",
          sourceKind: "project",
          trigger: "/search"
        }
      ]
    })
  );
  const merged = await capabilities;
  assert.equal(merged.models[0]?.value, "core-model");
  assert.equal(merged.skills[0]?.name, "search");
});

test("connector section replaces only connector capabilities", async () => {
  const harness = createHarness();
  const capabilities = harness.engine.loadComposerOptions({
    ...loadInput(),
    section: "capabilities"
  });
  harness.succeed(
    harness.commands[0]!.commandId,
    composerOptions("capability-model", {
      capabilityCatalog: [
        {
          id: "skill:review",
          invocation: "promptItem",
          kind: "skill",
          label: "Review",
          name: "review",
          status: "available"
        },
        {
          id: "connector:old",
          invocation: "textTrigger",
          kind: "connector",
          label: "Old",
          name: "old",
          status: "available"
        }
      ]
    })
  );
  await capabilities;

  const connectors = harness.engine.loadComposerOptions({
    ...loadInput(),
    section: "connectors"
  });
  assert.equal(harness.commands[1]?.type, "composerOptions/load");
  assert.equal(harness.commands[1]?.section, "connectors");
  harness.succeed(
    harness.commands[1]!.commandId,
    composerOptions("ignored-connector-model", {
      capabilityCatalog: [
        {
          id: "connector:new",
          invocation: "textTrigger",
          kind: "connector",
          label: "New",
          name: "new",
          status: "authRequired"
        }
      ]
    })
  );
  const merged = await connectors;

  assert.deepEqual(
    merged.capabilityCatalog?.map((capability) => capability.id),
    ["skill:review", "connector:new"]
  );
  assert.equal(merged.models[0]?.value, "capability-model");
});

test("semantic composer load joins an identical request and reuses its ready cache", async () => {
  const harness = createHarness();
  const first = harness.engine.loadComposerOptions(loadInput());
  const second = harness.engine.loadComposerOptions(loadInput());

  assert.equal(harness.commands.length, 1);
  const commandId = harness.commands[0]!.commandId;
  harness.succeed(commandId, composerOptions("gpt-5"));
  assert.equal((await first).models[0]?.value, "gpt-5");
  assert.equal((await second).models[0]?.value, "gpt-5");

  const cached = await harness.engine.loadComposerOptions(loadInput());
  assert.equal(cached.models[0]?.value, "gpt-5");
  assert.equal(harness.commands.length, 1);
});

test("semantic composer load rejects an exact request when a newer signature supersedes it", async () => {
  const harness = createHarness();
  const first = harness.engine.loadComposerOptions(loadInput({ cwd: "/old" }));
  const firstRejected = assert.rejects(
    first,
    /composer_options_load_superseded/
  );
  const second = harness.engine.loadComposerOptions(loadInput({ cwd: "/new" }));

  assert.equal(harness.commands.length, 2);
  await firstRejected;
  harness.succeed(
    harness.commands[0]!.commandId,
    composerOptions("stale-model")
  );
  harness.succeed(harness.commands[1]!.commandId, composerOptions("new-model"));
  assert.equal((await second).models[0]?.value, "new-model");
});

test("aborting one joined caller does not abort the shared composer load", async () => {
  const harness = createHarness();
  const first = harness.engine.loadComposerOptions(loadInput());
  const controller = new AbortController();
  const second = harness.engine.loadComposerOptions({
    ...loadInput(),
    signal: controller.signal
  });

  const abortReason = new Error("surface closed");
  controller.abort(abortReason);
  await assert.rejects(second, (error) => error === abortReason);
  assert.equal(harness.commands.length, 1);

  harness.succeed(
    harness.commands[0]!.commandId,
    composerOptions("shared-model")
  );
  assert.equal((await first).models[0]?.value, "shared-model");
});

test("a forced identical request joins an already-running composer load", async () => {
  const harness = createHarness();
  const first = harness.engine.loadComposerOptions(loadInput());
  const second = harness.engine.loadComposerOptions({
    ...loadInput(),
    force: true
  });

  assert.equal(harness.commands.length, 1);
  harness.succeed(
    harness.commands[0]!.commandId,
    composerOptions("forced-shared-model")
  );
  assert.equal((await first).models[0]?.value, "forced-shared-model");
  assert.equal((await second).models[0]?.value, "forced-shared-model");
});

test("invalidation keeps the current composer caller attached and makes the next load refetch", async () => {
  const harness = createHarness();
  const first = harness.engine.loadComposerOptions(loadInput());
  harness.engine.dispatch({
    targetKeys: ["target-1"],
    type: "composerOptions/invalidated"
  });
  harness.succeed(harness.commands[0]!.commandId, composerOptions("model-1"));
  assert.equal((await first).models[0]?.value, "model-1");

  const second = harness.engine.loadComposerOptions(loadInput());
  assert.equal(harness.commands.length, 2);
  harness.succeed(harness.commands[1]!.commandId, composerOptions("model-2"));
  assert.equal((await second).models[0]?.value, "model-2");
});

test("semantic composer load reports transport failure and engine disposal", async () => {
  const failedHarness = createHarness();
  const failed = failedHarness.engine.loadComposerOptions(loadInput());
  failedHarness.fail(
    failedHarness.commands[0]!.commandId,
    new Error("provider unavailable")
  );
  await assert.rejects(failed, /composer_options_load_failed/);

  const disposedHarness = createHarness();
  const disposed = disposedHarness.engine.loadComposerOptions(loadInput());
  disposedHarness.engine.dispose();
  await assert.rejects(disposed, /agent_session_engine_disposed/);
});
