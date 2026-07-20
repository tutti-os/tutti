import assert from "node:assert/strict";
import test from "node:test";
import type { AgentProviderStatus } from "@tutti-os/client-tuttid-ts";
import type { AgentProviderStatusSnapshot } from "../agentProviderStatusService.interface.ts";
import type { ReporterEventInput } from "../../../analytics/services/reporterService.interface.ts";
import { createDesktopAgentAvailabilitySnapshotPageviewReport } from "./desktopAgentAvailabilitySnapshotPageviewReport.ts";

test("pageview snapshot waits for refreshed provider information before reporting", async () => {
  const events: ReporterEventInput[] = [];
  let snapshot = createSnapshot([]);
  let resolveRefresh = () => {};
  const refreshFinished = new Promise<void>((resolve) => {
    resolveRefresh = resolve;
  });
  const report = createDesktopAgentAvailabilitySnapshotPageviewReport(
    {
      getSnapshot: () => snapshot,
      async refresh() {
        await refreshFinished;
        snapshot = createSnapshot([createReadyStatus("codex")]);
      }
    },
    {
      reporterService: {
        async trackEvents(nextEvents) {
          events.push(...nextEvents);
        }
      },
      storage: null
    }
  );

  const pendingReport = report();
  await Promise.resolve();
  assert.deepEqual(
    events.map((event) => event.name),
    []
  );

  resolveRefresh();
  await pendingReport;
  await Promise.resolve();

  const event = events.at(0);
  assert.ok(event);
  assert.equal(event.name, "agent.availability_snapshot");
  assert.equal(event.params?.provider, "codex");
  assert.equal(event.params?.trigger, "env_detected");
  assert.equal(events.length, 1);
});

test("pageview snapshot skips a failed refresh instead of reporting stale state", async () => {
  const events: ReporterEventInput[] = [];
  const report = createDesktopAgentAvailabilitySnapshotPageviewReport(
    {
      getSnapshot: () => ({
        ...createSnapshot([createReadyStatus("codex")]),
        error: "status refresh failed"
      }),
      async refresh() {}
    },
    {
      reporterService: {
        async trackEvents(nextEvents) {
          events.push(...nextEvents);
        }
      },
      storage: null
    }
  );

  await report();
  await Promise.resolve();

  assert.deepEqual(events, []);
});

function createSnapshot(
  statuses: readonly AgentProviderStatus[]
): AgentProviderStatusSnapshot {
  return {
    capturedAt: "2026-07-20T04:00:00.000Z",
    defaultProvider: "codex",
    error: null,
    isLoading: false,
    pendingActions: [],
    statuses
  };
}

function createReadyStatus(
  provider: AgentProviderStatus["provider"]
): AgentProviderStatus {
  return {
    actions: [],
    adapter: { command: [], installed: true },
    auth: { status: "authenticated" },
    availability: { status: "ready" },
    cli: { installed: true },
    provider
  };
}
