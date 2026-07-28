import assert from "node:assert/strict";
import test from "node:test";
import type { AgentHostAgentTargetSetupState } from "@tutti-os/agent-gui";
import { createDesktopTerminalLoginReadinessMonitor } from "./desktopTerminalLoginReadinessMonitor.ts";

const authRequiredState: AgentHostAgentTargetSetupState = {
  failed: false,
  loading: false,
  snapshot: {
    account: null,
    action: null,
    agentTargetId: "extension:kimi-code",
    authMethods: [],
    plan: null,
    reason: null,
    runtimeSource: "managed",
    runtimeVersion: "1.0.0",
    status: "auth_required"
  }
};

test("terminal login readiness monitor resolves after an immediate ready refresh", async () => {
  let state = authRequiredState;
  const monitor = createDesktopTerminalLoginReadinessMonitor({
    watch: {
      getSnapshot: () => state,
      refresh: async () => {
        state = {
          ...authRequiredState,
          snapshot: {
            ...authRequiredState.snapshot!,
            status: "ready"
          }
        };
      }
    }
  });

  assert.equal(await monitor.completion, "ready");
});

test("terminal login readiness monitor stops at its deadline", async () => {
  let now = 0;
  let scheduleCount = 0;
  const scheduledPolls: Array<() => void> = [];
  const monitor = createDesktopTerminalLoginReadinessMonitor({
    clock: () => now,
    pollIntervalMs: 3,
    schedule: (callback) => {
      scheduleCount += 1;
      scheduledPolls.push(callback);
      return () => undefined;
    },
    timeoutMs: 10,
    watch: {
      getSnapshot: () => authRequiredState,
      refresh: async () => undefined
    }
  });
  await Promise.resolve();
  assert.equal(scheduledPolls.length, 1);

  now = 10;
  scheduledPolls[0]?.();

  assert.equal(await monitor.completion, "timed_out");
  assert.equal(scheduleCount, 1);
});
