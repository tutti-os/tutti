import assert from "node:assert/strict";
import test from "node:test";
import { resolveAgentSessionReplayControlAvailability } from "./agentSessionReplayPlaybackControls.ts";

test("keeps replacement controls available after replay failure", () => {
  assert.deepEqual(
    resolveAgentSessionReplayControlAvailability({
      currentCheckpoint: 3,
      lastCheckpoint: 7,
      phase: "failed",
      updating: false
    }),
    {
      canNext: false,
      canPause: false,
      canPrevious: true,
      canReplace: true,
      canSetSpeed: false
    }
  );
});

test("enables transport controls only while replaying", () => {
  assert.deepEqual(
    resolveAgentSessionReplayControlAvailability({
      currentCheckpoint: 3,
      lastCheckpoint: 7,
      phase: "replaying",
      updating: false
    }),
    {
      canNext: true,
      canPause: true,
      canPrevious: true,
      canReplace: true,
      canSetSpeed: true
    }
  );
});

test("disables every control until replay phase is known", () => {
  assert.equal(
    Object.values(
      resolveAgentSessionReplayControlAvailability({
        currentCheckpoint: 3,
        lastCheckpoint: 7,
        phase: undefined,
        updating: false
      })
    ).some(Boolean),
    false
  );
});
