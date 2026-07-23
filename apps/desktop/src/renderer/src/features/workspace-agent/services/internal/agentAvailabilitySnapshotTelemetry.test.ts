import assert from "node:assert/strict";
import test from "node:test";
import type { AgentProviderStatus } from "@tutti-os/client-tuttid-ts";
import type { ReporterEventInput } from "../../../analytics/services/reporterService.interface.ts";
import {
  AgentAvailabilitySnapshotTelemetry,
  buildAvailabilitySnapshotParams,
  type AgentAvailabilitySnapshotStorage
} from "./agentAvailabilitySnapshotTelemetry.ts";

test("availability snapshots cover initial, change, and rollover triggers", async () => {
  let now = new Date(2026, 6, 20, 12).getTime();
  const events: ReporterEventInput[] = [];
  const storage = createMemoryStorage();
  const telemetry = new AgentAvailabilitySnapshotTelemetry({
    now: () => now,
    reporterService: {
      async trackEvents(input) {
        events.push(...input);
      }
    },
    storage
  });
  const codexUnavailable = status({
    authenticated: false,
    availability: "not_installed",
    cliInstalled: false,
    provider: "codex"
  });
  const claudeReady = status({
    authenticated: true,
    availability: "ready",
    cliInstalled: true,
    provider: "claude-code"
  });

  telemetry.reportStatuses([codexUnavailable, claudeReady]);
  telemetry.reportStatuses([codexUnavailable, claudeReady]);
  await flushAsyncWork();

  assert.deepEqual(
    events.map((event) => [
      event.params?.provider,
      event.params?.trigger,
      event.params?.is_available,
      event.params?.unavailable_reason
    ]),
    [
      ["codex", "env_detected", false, "cli_not_installed"],
      ["claude_code", "env_detected", true, "none"],
      ["codex", "env_detected", false, "cli_not_installed"],
      ["claude_code", "env_detected", true, "none"]
    ]
  );

  telemetry.reportStatuses([
    status({
      authenticated: true,
      availability: "ready",
      cliInstalled: true,
      provider: "codex"
    })
  ]);
  await flushAsyncWork();
  assert.equal(events.at(-1)?.params?.trigger, "config_change");

  // A new instance shares persisted state for trigger classification without
  // suppressing its own pageview opportunity.
  new AgentAvailabilitySnapshotTelemetry({
    now: () => now,
    reporterService: {
      async trackEvents(input) {
        events.push(...input);
      }
    },
    storage
  }).reportStatuses([claudeReady]);
  await flushAsyncWork();
  assert.equal(events.length, 6);

  now = new Date(2026, 6, 21, 9).getTime();
  telemetry.reportStatuses([
    status({
      authenticated: true,
      availability: "ready",
      cliInstalled: true,
      provider: "codex"
    })
  ]);
  telemetry.reportStatuses([claudeReady]);
  await flushAsyncWork();

  assert.deepEqual(
    events
      .slice(-2)
      .map((event) => [event.params?.provider, event.params?.trigger]),
    [
      ["codex", "daily_rollover"],
      ["claude_code", "daily_rollover"]
    ]
  );
});

test("availability requires installed CLI, authentication, and ready provider", () => {
  const params = buildAvailabilitySnapshotParams(
    status({
      authenticated: true,
      availability: "unknown",
      cliInstalled: true,
      provider: "opencode"
    }),
    "env_detected"
  );

  assert.equal(params.isAvailable, false);
  assert.equal(params.unavailableReason, "provider_error");
});

test("availability reports an explicit conversation failure trigger", async () => {
  const events: ReporterEventInput[] = [];
  const telemetry = new AgentAvailabilitySnapshotTelemetry({
    now: () => 1_749_124_800_000,
    reporterService: {
      async trackEvents(input) {
        events.push(...input);
      }
    },
    storage: createMemoryStorage()
  });

  telemetry.reportStatus(
    status({
      authenticated: false,
      availability: "auth_required",
      cliInstalled: true,
      provider: "cursor"
    }),
    "conversation_start_failed"
  );
  await flushAsyncWork();

  assert.deepEqual(
    events.map((event) => event.params),
    [
      {
        authenticated: false,
        cli_installed: true,
        error_code: "agent_error_none",
        error_message: "",
        is_available: false,
        provider: "cursor",
        trigger: "conversation_start_failed",
        unavailable_reason: "not_authenticated"
      }
    ]
  );
});

test("availability rollover uses the activation time supplied by its lifecycle", async () => {
  const events: ReporterEventInput[] = [];
  const telemetry = new AgentAvailabilitySnapshotTelemetry({
    now: () => new Date(2026, 6, 21, 0, 1).getTime(),
    reporterService: {
      async trackEvents(input) {
        events.push(...input);
      }
    },
    storage: createMemoryStorage()
  });
  const ready = status({
    authenticated: true,
    availability: "ready",
    cliInstalled: true,
    provider: "codex"
  });

  telemetry.reportStatuses([ready], new Date(2026, 6, 20, 23, 59).getTime());
  telemetry.reportStatuses([ready], new Date(2026, 6, 21, 0, 0).getTime());
  await flushAsyncWork();

  assert.deepEqual(
    events.map((event) => [event.clientTS, event.params?.trigger]),
    [
      [new Date(2026, 6, 20, 23, 59).getTime(), "env_detected"],
      [new Date(2026, 6, 21, 0, 0).getTime(), "daily_rollover"]
    ]
  );
});

function status(input: {
  authenticated: boolean;
  availability: AgentProviderStatus["availability"]["status"];
  cliInstalled: boolean;
  provider: string;
}): AgentProviderStatus {
  return {
    actions: [],
    adapter: { command: [], installed: true },
    auth: {
      status: input.authenticated ? "authenticated" : "required"
    },
    availability: { status: input.availability },
    cli: { installed: input.cliInstalled },
    provider: input.provider,
    update: {
      capability: "unsupported",
      currentVersion: null,
      lastCheckedAt: null,
      latestVersion: null,
      reasonCode: null,
      source: null,
      unsupportedReason: "update_strategy_unsupported",
      updateAvailable: null
    }
  };
}

function createMemoryStorage(): AgentAvailabilitySnapshotStorage {
  const values = new Map<string, string>();
  return {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    }
  };
}

async function flushAsyncWork(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
