import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentComposerDefaultsPatchCoordinator,
  AgentComposerDefaultsPatchFailure
} from "./agentComposerDefaultsPatchCoordinator.ts";

test("agent composer defaults patch retries three times and reports safe metadata", async () => {
  const calls: unknown[] = [];
  const coordinator = new AgentComposerDefaultsPatchCoordinator({
    createCorrelationId: () => "mutation-1",
    now: () => 25,
    retryDelaysMs: [0, 0],
    publish: async (input) => {
      calls.push(input);
      throw Object.assign(new Error("daemon unavailable"), {
        code: "unavailable"
      });
    }
  });

  await assert.rejects(
    coordinator.patch("local:opencode", { permissionModeId: "full-access" }),
    (error) => {
      assert.ok(error instanceof AgentComposerDefaultsPatchFailure);
      assert.deepEqual(error.details, {
        agentTargetId: "local:opencode",
        attemptCount: 3,
        changedFields: ["permissionModeId"],
        correlationId: "mutation-1",
        durationMs: 0,
        errorCode: "unavailable",
        errorMessage: "daemon unavailable"
      });
      return true;
    }
  );
  assert.equal(calls.length, 3);
  coordinator.dispose();
});

test("agent composer defaults patch serializes in-flight writes so the latest field value wins", async () => {
  const calls: Array<{
    patch: { permissionModeId?: string | null };
    resolve: () => void;
  }> = [];
  const coordinator = new AgentComposerDefaultsPatchCoordinator({
    createCorrelationId: () => `mutation-${calls.length + 1}`,
    publish: (input) =>
      new Promise<void>((resolve) => {
        calls.push({ patch: input.patch, resolve });
      })
  });

  const oldWrite = coordinator.patch("local:opencode", {
    permissionModeId: "ask"
  });
  const latestWrite = coordinator.patch("local:opencode", {
    permissionModeId: "full-access"
  });
  assert.deepEqual(
    calls.map((call) => call.patch),
    [{ permissionModeId: "ask" }]
  );

  assert.deepEqual(await oldWrite, {
    acknowledgedFields: [],
    supersededFields: ["permissionModeId"]
  });

  calls[0]!.resolve();
  await Promise.resolve();
  assert.deepEqual(
    calls.map((call) => call.patch),
    [{ permissionModeId: "ask" }, { permissionModeId: "full-access" }]
  );

  calls[1]!.resolve();
  assert.deepEqual(await latestWrite, {
    acknowledgedFields: ["permissionModeId"],
    supersededFields: []
  });
  coordinator.dispose();
});

test("agent composer defaults patch distinguishes A to B to A generations", async () => {
  const calls: Array<{
    patch: { permissionModeId?: string | null };
    resolve: () => void;
  }> = [];
  const coordinator = new AgentComposerDefaultsPatchCoordinator({
    publish: (input) =>
      new Promise<void>((resolve) => {
        calls.push({ patch: input.patch, resolve });
      })
  });

  const firstA = coordinator.patch("local:opencode", {
    permissionModeId: "ask"
  });
  const writeB = coordinator.patch("local:opencode", {
    permissionModeId: "full-access"
  });
  const latestA = coordinator.patch("local:opencode", {
    permissionModeId: "ask"
  });

  assert.deepEqual(await firstA, {
    acknowledgedFields: [],
    supersededFields: ["permissionModeId"]
  });
  assert.deepEqual(await writeB, {
    acknowledgedFields: [],
    supersededFields: ["permissionModeId"]
  });
  assert.deepEqual(
    calls.map((call) => call.patch),
    [{ permissionModeId: "ask" }]
  );

  calls[0]!.resolve();
  await Promise.resolve();
  assert.deepEqual(
    calls.map((call) => call.patch),
    [{ permissionModeId: "ask" }, { permissionModeId: "ask" }]
  );
  calls[1]!.resolve();
  assert.deepEqual(await latestA, {
    acknowledgedFields: ["permissionModeId"],
    supersededFields: []
  });
  coordinator.dispose();
});

test("agent composer defaults patch reports mixed per-field outcomes", async () => {
  const calls: Array<{
    patch: { model?: string | null; permissionModeId?: string | null };
    resolve: () => void;
  }> = [];
  const coordinator = new AgentComposerDefaultsPatchCoordinator({
    publish: (input) =>
      new Promise<void>((resolve) => {
        calls.push({ patch: input.patch, resolve });
      })
  });

  const mixedWrite = coordinator.patch("local:opencode", {
    model: "openai/gpt-5",
    permissionModeId: "ask"
  });
  const latestPermission = coordinator.patch("local:opencode", {
    permissionModeId: "full-access"
  });
  let mixedSettled = false;
  void mixedWrite.then(() => {
    mixedSettled = true;
  });
  await Promise.resolve();
  assert.equal(mixedSettled, false);

  calls[0]!.resolve();
  assert.deepEqual(await mixedWrite, {
    acknowledgedFields: ["model"],
    supersededFields: ["permissionModeId"]
  });
  await Promise.resolve();
  calls[1]!.resolve();
  assert.deepEqual(await latestPermission, {
    acknowledgedFields: ["permissionModeId"],
    supersededFields: []
  });
  coordinator.dispose();
});

test("agent composer defaults patch merges latest values for different fields", async () => {
  const calls: Array<{
    patch: {
      model?: string | null;
      permissionModeId?: string | null;
    };
    reject: (error: Error) => void;
    resolve: () => void;
  }> = [];
  const coordinator = new AgentComposerDefaultsPatchCoordinator({
    createCorrelationId: () => `mutation-${calls.length + 1}`,
    retryDelaysMs: [0, 0],
    publish: (input) =>
      new Promise<void>((resolve, reject) => {
        calls.push({ patch: input.patch, reject, resolve });
      })
  });

  const permissionWrite = coordinator.patch("local:opencode", {
    permissionModeId: "full-access"
  });
  calls[0]!.reject(new Error("retry"));
  const modelWrite = coordinator.patch("local:opencode", {
    model: "openai/gpt-5"
  });
  await Promise.resolve();
  assert.deepEqual(calls[1]!.patch, {
    model: "openai/gpt-5",
    permissionModeId: "full-access"
  });
  calls[1]!.resolve();

  await Promise.all([permissionWrite, modelWrite]);
  coordinator.dispose();
});

test("disposing the coordinator cancels pending retries without surfacing an error", async () => {
  let calls = 0;
  const coordinator = new AgentComposerDefaultsPatchCoordinator({
    retryDelaysMs: [10_000, 10_000],
    publish: async () => {
      calls += 1;
      throw new Error("retry");
    }
  });
  const write = coordinator.patch("local:codex", { model: "gpt-5" });
  await Promise.resolve();
  coordinator.dispose();
  await write;
  assert.equal(calls, 1);
});
