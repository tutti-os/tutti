// Shared elapsed-time helpers for agent conversation rows.
//
// A single module-level heartbeat drives every live timer so concurrent
// processing/compaction rows tick in lockstep instead of each spinning up its
// own setInterval. Non-live rows (e.g. a finished turn's fixed duration) never
// subscribe to the heartbeat -- they just render the delta between the two
// supplied timestamps, so they re-render only when projection feeds them new
// data.

import { useEffect, useState } from "react";

const TICK_MS = 1000;

let heartbeatSubscribers = 0;
const heartbeatSubscribersSet = new Set<(nowUnixMs: number) => void>();
let heartbeatHandle: ReturnType<typeof setInterval> | null = null;

function startHeartbeat(): void {
  if (heartbeatHandle !== null) {
    return;
  }
  heartbeatHandle = setInterval(() => {
    const nowUnixMs = Date.now();
    for (const subscriber of heartbeatSubscribersSet) {
      subscriber(nowUnixMs);
    }
  }, TICK_MS);
}

function stopHeartbeat(): void {
  if (heartbeatHandle !== null) {
    clearInterval(heartbeatHandle);
    heartbeatHandle = null;
  }
}

function subscribeHeartbeat(onTick: (nowUnixMs: number) => void): () => void {
  heartbeatSubscribers += 1;
  heartbeatSubscribersSet.add(onTick);
  startHeartbeat();
  return () => {
    heartbeatSubscribersSet.delete(onTick);
    heartbeatSubscribers -= 1;
    if (heartbeatSubscribers <= 0) {
      stopHeartbeat();
    }
  };
}

/**
 * Returns the elapsed seconds for a span that started at `startedAtUnixMs`.
 *
 * `live` rows re-render every second via the shared heartbeat; non-live rows
 * freeze at `completedAtUnixMs` and never subscribe to the ticker. When the
 * start is missing or invalid, returns `null` (callers fall back to a label).
 */
export function useElapsedSeconds(
  startedAtUnixMs: number | null,
  completedAtUnixMs: number | null,
  live: boolean
): number | null {
  // State exists only to force a re-render when the heartbeat ticks.
  // The elapsed time is always computed from the real Date.now() on every
  // render so the display never shows a stale cached value — even when the
  // heartbeat is throttled (e.g. during AskUserQuestion / interactive
  // prompts in Electron).
  const [, forceRender] = useState(0);

  useEffect(() => {
    if (!isPositiveUnixMs(startedAtUnixMs) || !live) {
      return;
    }
    // Sync at least one render immediately with the current wall-clock time.
    forceRender((n) => n + 1);
    return subscribeHeartbeat(() => forceRender((n) => n + 1));
  }, [live, startedAtUnixMs]);

  return computeElapsedSeconds(
    startedAtUnixMs,
    completedAtUnixMs,
    Date.now(),
    live
  );
}

export function isPositiveUnixMs(value: number | null): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function computeElapsedSeconds(
  startedAtUnixMs: number | null,
  completedAtUnixMs: number | null,
  nowUnixMs: number,
  live: boolean
): number | null {
  if (!isPositiveUnixMs(startedAtUnixMs)) {
    return null;
  }
  const endUnixMs = live
    ? nowUnixMs
    : isPositiveUnixMs(completedAtUnixMs)
      ? completedAtUnixMs
      : nowUnixMs;
  return Math.max(0, Math.floor((endUnixMs - startedAtUnixMs) / 1000));
}

export function formatElapsedSeconds(elapsedSeconds: number): string {
  if (elapsedSeconds < 60) {
    return `${elapsedSeconds}s`;
  }
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}
export type ElapsedLabelKeyPrefix = "processingElapsed" | "turnElapsed";

export type ElapsedLabelTranslate = (
  key: string,
  values: { count?: number; minutes?: number; seconds?: number }
) => string;

const ELAPSED_LABEL_KEYS: Record<
  ElapsedLabelKeyPrefix,
  { seconds: string; minutes: string; minutesOnly: string }
> = {
  processingElapsed: {
    seconds: "agentHost.agentGui.processingElapsedSeconds",
    minutes: "agentHost.agentGui.processingElapsedMinutes",
    minutesOnly: "agentHost.agentGui.processingElapsedMinutesOnly"
  },
  turnElapsed: {
    seconds: "agentHost.agentGui.turnElapsedSeconds",
    minutes: "agentHost.agentGui.turnElapsedMinutes",
    minutesOnly: "agentHost.agentGui.turnElapsedMinutesOnly"
  }
};

export function formatLocalizedElapsedLabel(
  translate: ElapsedLabelTranslate,
  elapsedSeconds: number,
  keyPrefix: ElapsedLabelKeyPrefix
): string {
  const keys = ELAPSED_LABEL_KEYS[keyPrefix];
  if (elapsedSeconds < 60) {
    return translate(keys.seconds, {
      count: elapsedSeconds
    });
  }
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  if (seconds === 0) {
    return translate(keys.minutesOnly, { minutes });
  }
  return translate(keys.minutes, {
    minutes,
    seconds
  });
}
