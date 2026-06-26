import assert from "node:assert/strict";
import { test } from "node:test";
import { loadAllAgentSessionMessages } from "./pagination.ts";

interface TestMessage {
  messageId: string;
  version: number;
}

/**
 * Mimic the daemon's `ListSessionMessages` contract: ascending by version,
 * `version > afterVersion`, capped at `limit`, reporting `hasMore`.
 */
function paginatingSource(total: number, limit: number) {
  const all: TestMessage[] = Array.from({ length: total }, (_, index) => ({
    messageId: `m-${index + 1}`,
    version: index + 1
  }));
  const calls: number[] = [];
  const listPage = async (afterVersion: number) => {
    calls.push(afterVersion);
    const remaining = all.filter((message) => message.version > afterVersion);
    return {
      messages: remaining.slice(0, limit),
      hasMore: remaining.length > limit
    };
  };
  return { listPage, calls };
}

test("loadAllAgentSessionMessages follows the cursor across every page", async () => {
  const { listPage, calls } = paginatingSource(415, 100);

  const result = await loadAllAgentSessionMessages({ listPage });

  // The bug this guards: a single-page load returned only the oldest 100
  // messages and dropped the remaining 315.
  assert.equal(result.aborted, false);
  assert.equal(result.messages.length, 415);
  assert.deepEqual(
    result.messages.map((message) => message.version),
    Array.from({ length: 415 }, (_, index) => index + 1)
  );
  assert.deepEqual(calls, [0, 100, 200, 300, 400]);
});

test("loadAllAgentSessionMessages stops after one page when nothing more remains", async () => {
  const { listPage, calls } = paginatingSource(42, 100);

  const result = await loadAllAgentSessionMessages({ listPage });

  assert.equal(result.messages.length, 42);
  assert.deepEqual(calls, [0]);
});

test("loadAllAgentSessionMessages resumes from a non-zero cursor", async () => {
  const { listPage, calls } = paginatingSource(250, 100);

  const result = await loadAllAgentSessionMessages({
    listPage,
    afterVersion: 100
  });

  assert.equal(result.messages.length, 150);
  assert.equal(result.messages[0]?.version, 101);
  assert.deepEqual(calls, [100, 200]);
});

test("loadAllAgentSessionMessages reports each accepted page via onPage", async () => {
  const { listPage } = paginatingSource(250, 100);
  const pageSizes: number[] = [];

  await loadAllAgentSessionMessages({
    listPage,
    onPage: (messages) => pageSizes.push(messages.length)
  });

  assert.deepEqual(pageSizes, [100, 100, 50]);
});

test("loadAllAgentSessionMessages aborts without collecting the aborting page", async () => {
  const { listPage, calls } = paginatingSource(415, 100);
  let pages = 0;
  const onPage: number[] = [];

  const result = await loadAllAgentSessionMessages({
    listPage,
    onPage: (messages) => onPage.push(messages.length),
    shouldAbort: () => {
      pages += 1;
      return pages >= 2;
    }
  });

  assert.equal(result.aborted, true);
  assert.equal(calls.length, 2);
  // Only the first page was accepted; the second (aborting) page was dropped.
  assert.deepEqual(onPage, [100]);
  assert.equal(result.messages.length, 100);
});

test("loadAllAgentSessionMessages terminates if hasMore never advances the cursor", async () => {
  let calls = 0;
  const listPage = async () => {
    calls += 1;
    return { messages: [{ messageId: "stuck", version: 1 }], hasMore: true };
  };

  const result = await loadAllAgentSessionMessages({ listPage, maxPages: 50 });

  assert.equal(result.aborted, false);
  // Second page fails to advance the cursor (1 -> 1), so the walk stops instead
  // of spinning up to maxPages.
  assert.equal(calls, 2);
});
