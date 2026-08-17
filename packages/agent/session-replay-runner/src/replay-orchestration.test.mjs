import assert from "node:assert/strict";
import test from "node:test";
import { runReplayCassetteBatch } from "./replay-orchestration.mjs";

function cassettes() {
  return [{ cassetteId: "cassette-a" }, { cassetteId: "cassette-b" }];
}

test("first cassette failure aborts the sibling and preserves its root cause", async () => {
  const rootCause = new Error("first cassette failed");
  let siblingSignal;
  const terminal = [];

  const batch = await runReplayCassetteBatch(
    cassettes(),
    (cassette, signal) => {
      if (cassette.cassetteId === "cassette-a") {
        return Promise.reject(rootCause);
      }
      siblingSignal = signal;
      return new Promise((resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new Error("sibling abort failure")),
          {
            once: true
          }
        );
      });
    },
    {
      onTerminal(cassette, outcome) {
        terminal.push({
          cassetteId: cassette.cassetteId,
          error: outcome.error,
          succeeded: outcome.succeeded
        });
      }
    }
  );

  assert.equal(siblingSignal?.aborted, true);
  assert.equal(batch.firstFailure?.cassetteId, "cassette-a");
  assert.strictEqual(batch.firstFailure?.error, rootCause);
  assert.strictEqual(batch.results[0]?.error, rootCause);
  assert.strictEqual(batch.results[1]?.error, rootCause);
  assert.deepEqual(
    terminal.map(({ cassetteId, succeeded }) => ({ cassetteId, succeeded })),
    [
      { cassetteId: "cassette-a", succeeded: false },
      { cassetteId: "cassette-b", succeeded: false }
    ]
  );
});

test("a late sibling completion cannot emit a complete terminal outcome", async () => {
  const rootCause = new Error("first cassette failed");
  let releaseSibling;
  let siblingSignal;
  const terminal = [];

  const batch = await runReplayCassetteBatch(
    cassettes(),
    (cassette, signal) => {
      if (cassette.cassetteId === "cassette-a") {
        return Promise.reject(rootCause);
      }
      siblingSignal = signal;
      return new Promise((resolve) => {
        releaseSibling = resolve;
      });
    },
    {
      onTerminal(cassette, outcome) {
        terminal.push({
          cassetteId: cassette.cassetteId,
          succeeded: outcome.succeeded
        });
      }
    }
  );

  assert.equal(siblingSignal?.aborted, true);
  assert.deepEqual(terminal, [
    { cassetteId: "cassette-a", succeeded: false },
    { cassetteId: "cassette-b", succeeded: false }
  ]);
  releaseSibling();
  await Promise.resolve();
  assert.deepEqual(terminal, [
    { cassetteId: "cassette-a", succeeded: false },
    { cassetteId: "cassette-b", succeeded: false }
  ]);
  assert.equal(batch.terminalOutcomes.get("cassette-b")?.succeeded, false);
});

test("successful cassette batch emits one complete terminal outcome per cassette", async () => {
  const terminal = [];
  const batch = await runReplayCassetteBatch(
    cassettes(),
    async (cassette) => ({ value: cassette.cassetteId }),
    {
      onTerminal(cassette, outcome) {
        terminal.push({
          cassetteId: cassette.cassetteId,
          result: outcome.result,
          succeeded: outcome.succeeded
        });
      }
    }
  );

  assert.equal(batch.firstFailure, null);
  assert.deepEqual(terminal, [
    {
      cassetteId: "cassette-a",
      result: { value: "cassette-a" },
      succeeded: true
    },
    {
      cassetteId: "cassette-b",
      result: { value: "cassette-b" },
      succeeded: true
    }
  ]);
});

test("workspace deadline aborts every unsettled cassette", async () => {
  let firstFailure;
  let cassetteSignal;
  const terminal = [];
  const batch = await runReplayCassetteBatch(
    cassettes(),
    (_cassette, signal) => {
      cassetteSignal = signal;
      return new Promise(() => {});
    },
    {
      timeoutMs: 20,
      onFirstFailure(failure) {
        firstFailure = failure;
      },
      onTerminal(cassette, outcome) {
        terminal.push({
          cassetteId: cassette.cassetteId,
          succeeded: outcome.succeeded
        });
      }
    }
  );

  assert.match(firstFailure?.error?.message ?? "", /20ms deadline/u);
  assert.equal(cassetteSignal?.aborted, true);
  assert.deepEqual(terminal, [
    { cassetteId: "cassette-a", succeeded: false },
    { cassetteId: "cassette-b", succeeded: false }
  ]);
  assert.equal(batch.firstFailure, firstFailure);
});
