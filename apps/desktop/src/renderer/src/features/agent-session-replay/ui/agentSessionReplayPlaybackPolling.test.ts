import assert from "node:assert/strict";
import test from "node:test";
import {
  areAgentSessionReplayPlaybackSnapshotsEqual,
  shouldPollAgentSessionReplayPlayback
} from "./agentSessionReplayPlaybackPolling.ts";

const inactivePlayback = {
  active: false,
  paused: false,
  speed: 1,
  timingMode: "realtime"
} as const;

test("polls playback while an isolated replay is active", () => {
  assert.equal(
    shouldPollAgentSessionReplayPlayback(inactivePlayback, {
      active: true,
      phase: "replaying"
    }),
    true
  );
  assert.equal(
    shouldPollAgentSessionReplayPlayback(inactivePlayback, {
      active: true,
      phase: "verifying"
    }),
    true
  );
});

test("stops polling outside an active replay", () => {
  assert.equal(
    shouldPollAgentSessionReplayPlayback(inactivePlayback, { active: false }),
    false
  );
  assert.equal(
    shouldPollAgentSessionReplayPlayback(inactivePlayback, {
      active: true,
      phase: "complete"
    }),
    false
  );
});

test("does not publish unchanged polling snapshots", () => {
  const snapshot = {
    playback: {
      active: true,
      paused: true,
      speed: 2,
      timingMode: "realtime"
    } as const,
    status: {
      active: true,
      currentCheckpoint: 2,
      paused: true,
      phase: "replaying",
      targetCheckpoint: null,
      timingMode: "realtime",
      totalCheckpoints: 4
    } as const
  };

  assert.equal(
    areAgentSessionReplayPlaybackSnapshotsEqual(snapshot, {
      playback: { ...snapshot.playback },
      status: { ...snapshot.status }
    }),
    true
  );
  assert.equal(
    areAgentSessionReplayPlaybackSnapshotsEqual(snapshot, {
      playback: { ...snapshot.playback },
      status: { ...snapshot.status, currentCheckpoint: 3 }
    }),
    false
  );
});
