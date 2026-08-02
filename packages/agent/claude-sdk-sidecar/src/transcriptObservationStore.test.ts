import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  SessionKey,
  SessionStore,
  SessionStoreEntry
} from "@anthropic-ai/claude-agent-sdk";
import { TranscriptObservationStore } from "./transcriptObservationStore.ts";

test("load replays the native transcript through the SDK without taking over resume storage", async () => {
  const key: SessionKey = {
    projectKey: "-workspace",
    sessionId: "session-1"
  };
  const entries: SessionStoreEntry[] = [
    { type: "user", uuid: "entry-1", timestamp: "2026-08-02T00:00:00Z" },
    {
      type: "attachment",
      uuid: "goal-complete",
      timestamp: "2026-08-02T00:00:01Z",
      attachment: { type: "goal_status", condition: "ship it", met: true }
    }
  ];

  let observed: readonly SessionStoreEntry[] = [];
  const store = new TranscriptObservationStore(
    "/workspace",
    (_key, batch) => {
      observed = batch;
    },
    async (sessionId, destination, options) => {
      assert.equal(sessionId, key.sessionId);
      assert.deepEqual(options, {
        dir: "/workspace",
        includeSubagents: false
      });
      await destination.append(key, entries);
    }
  );

  assert.equal(await store.load(key), null);
  assert.deepEqual(observed, entries);
});

test("load never blocks native resume when SDK replay fails", async () => {
  const store = new TranscriptObservationStore(
    "/workspace",
    () => assert.fail("failed replay must not emit transcript entries"),
    async () => {
      throw new Error("transcript unavailable");
    }
  );

  assert.equal(
    await store.load({ projectKey: "-workspace", sessionId: "session-1" }),
    null
  );
});

test("load does not replay subagent transcripts", async () => {
  let replayed = false;
  const store = new TranscriptObservationStore(
    "/workspace",
    () => assert.fail("subagent replay must not emit transcript entries"),
    async (_sessionId: string, _store: SessionStore) => {
      replayed = true;
    }
  );

  assert.equal(
    await store.load({
      projectKey: "-workspace",
      sessionId: "session-1",
      subpath: "subagents/agent-1"
    }),
    null
  );
  assert.equal(replayed, false);
});
