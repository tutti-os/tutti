import assert from "node:assert/strict";
import test from "node:test";
import { agentActivitySessionMessageWindowFromDescendingPage } from "./pagination.ts";

test("uses descending page metadata instead of treating a high version as older history", () => {
  assert.deepEqual(
    agentActivitySessionMessageWindowFromDescendingPage({
      hasMore: false,
      messages: [{ version: 446 }]
    }),
    {
      hasOlderMessages: false,
      oldestLoadedVersion: 446
    }
  );
});

test("preserves an authoritative older-page boundary", () => {
  assert.deepEqual(
    agentActivitySessionMessageWindowFromDescendingPage({
      hasMore: true,
      messages: [{ version: 446 }, { version: 301 }]
    }),
    {
      hasOlderMessages: true,
      oldestLoadedVersion: 301
    }
  );
});
