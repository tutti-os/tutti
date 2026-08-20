import assert from "node:assert/strict";
import test from "node:test";
import {
  QueryGeneration,
  QueryShutdownTimeoutError,
  type QueryShutdownStage
} from "./queryGeneration.ts";

test("query shutdown closes transport when interrupt acknowledgement times out", async () => {
  const generation = new QueryGeneration(41);
  const stages: QueryShutdownStage[] = [];
  let closed = false;
  generation.query = {
    async *[Symbol.asyncIterator]() {},
    async interrupt() {
      await new Promise(() => {});
    },
    close() {
      closed = true;
    }
  };
  generation.consumption = Promise.resolve();

  const result = await generation.shutdown(true, {
    interruptTimeoutMs: 10,
    drainTimeoutMs: 10,
    observe: (stage) => stages.push(stage)
  });

  assert.equal(closed, true);
  assert.deepEqual(result, { terminationMode: "transport_closed" });
  assert.deepEqual(stages, [
    "shutdown_started",
    "interrupt_started",
    "interrupt_timed_out",
    "query_close_started",
    "query_close_succeeded",
    "consumption_wait_started",
    "consumption_settled",
    "shutdown_succeeded"
  ]);
});

test("query shutdown reports a bounded failure when consumption cannot drain", async () => {
  const generation = new QueryGeneration(42);
  const stages: QueryShutdownStage[] = [];
  generation.query = {
    async *[Symbol.asyncIterator]() {},
    async interrupt() {},
    close() {}
  };
  generation.consumption = new Promise(() => {});

  await assert.rejects(
    generation.shutdown(true, {
      interruptTimeoutMs: 10,
      drainTimeoutMs: 10,
      observe: (stage) => stages.push(stage)
    }),
    (error: unknown) =>
      error instanceof QueryShutdownTimeoutError &&
      error.stage === "consumption"
  );
  assert.deepEqual(stages, [
    "shutdown_started",
    "interrupt_started",
    "interrupt_succeeded",
    "query_close_started",
    "query_close_succeeded",
    "consumption_wait_started",
    "consumption_timed_out"
  ]);
});
