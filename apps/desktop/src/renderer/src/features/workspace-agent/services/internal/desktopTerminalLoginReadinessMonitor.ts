import type { AgentHostAgentTargetSetupWatch } from "@tutti-os/agent-gui";

const DEFAULT_POLL_INTERVAL_MS = 3_000;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

export interface DesktopTerminalLoginReadinessMonitor {
  cancel(): void;
  completion: Promise<"ready" | "timed_out">;
}

interface DesktopTerminalLoginReadinessMonitorInput {
  clock?: () => number;
  pollIntervalMs?: number;
  schedule?: (callback: () => void, delayMs: number) => () => void;
  timeoutMs?: number;
  watch: Pick<AgentHostAgentTargetSetupWatch, "getSnapshot" | "refresh">;
}

export function createDesktopTerminalLoginReadinessMonitor(
  input: DesktopTerminalLoginReadinessMonitorInput
): DesktopTerminalLoginReadinessMonitor {
  const clock = input.clock ?? Date.now;
  const pollIntervalMs = input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutAt = clock() + (input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const schedule = input.schedule ?? scheduleTimeout;
  let cancelScheduledPoll: (() => void) | null = null;
  let canceled = false;
  let settled = false;
  let resolveCompletion: ((result: "ready" | "timed_out") => void) | null =
    null;
  const completion = new Promise<"ready" | "timed_out">((resolve) => {
    resolveCompletion = resolve;
  });
  const finish = (result: "ready" | "timed_out") => {
    if (canceled || settled) return;
    settled = true;
    cancelScheduledPoll?.();
    cancelScheduledPoll = null;
    resolveCompletion?.(result);
    resolveCompletion = null;
  };
  const poll = async () => {
    cancelScheduledPoll = null;
    if (canceled || settled) return;
    if (clock() >= timeoutAt) {
      finish("timed_out");
      return;
    }
    try {
      await input.watch.refresh();
    } catch {
      // The setup watch owns request errors; keep the bounded readiness loop.
    }
    if (canceled || settled) return;
    if (input.watch.getSnapshot().snapshot?.status === "ready") {
      finish("ready");
      return;
    }
    cancelScheduledPoll = schedule(() => void poll(), pollIntervalMs);
  };

  void poll();

  return {
    cancel() {
      if (canceled || settled) return;
      canceled = true;
      cancelScheduledPoll?.();
      cancelScheduledPoll = null;
      resolveCompletion = null;
    },
    completion
  };
}

function scheduleTimeout(callback: () => void, delayMs: number): () => void {
  const timer = globalThis.setTimeout(callback, delayMs);
  return () => globalThis.clearTimeout(timer);
}
