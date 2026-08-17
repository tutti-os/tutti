import assert from "node:assert/strict";
import test from "node:test";
import { evaluate, withTimeout } from "./agent-gui-performance-helpers.mjs";

test("withTimeout rejects when the promise never settles", async () => {
  await assert.rejects(
    () => withTimeout(new Promise(() => {}), 40, "hard timeout fired"),
    /hard timeout fired/u
  );
});

test("withTimeout resolves when the promise settles first", async () => {
  const value = await withTimeout(
    Promise.resolve("ok"),
    1_000,
    "should not fire"
  );
  assert.equal(value, "ok");
});

test("evaluate hard-times out when Runtime.evaluate never resolves", async () => {
  const client = {
    async send() {
      return new Promise(() => {});
    }
  };
  await assert.rejects(
    () => evaluate(client, "1 + 1", false, 40),
    /Runtime\.evaluate timed out after 1s/u
  );
});

test("evaluate still returns values when CDP responds", async () => {
  const client = {
    async send(method, payload) {
      assert.equal(method, "Runtime.evaluate");
      assert.equal(payload.timeout, 1_000);
      return { result: { value: 42 } };
    }
  };
  assert.equal(await evaluate(client, "40 + 2", false, 1_000), 42);
});
