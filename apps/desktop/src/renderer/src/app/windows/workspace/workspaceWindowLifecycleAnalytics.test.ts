import assert from "node:assert/strict";
import test from "node:test";
import { startPredefinePageviewAnalytics } from "../../../features/analytics/predefinePageviewAnalytics.ts";
import type { ReporterEventInput } from "../../../features/analytics/services/reporterService.interface.ts";
import { startDesktopAgentAvailabilitySnapshotAnalytics } from "../../../features/workspace-agent/desktopAgentAvailabilitySnapshotAnalytics.ts";
import {
  createWorkspaceWindowLifecycle,
  type WorkspaceWindowLifecycleRuntime
} from "../../../lib/workspaceWindowLifecycle.ts";

test("workspace lifecycle gives pageview and availability the same activation opportunities", async () => {
  const events: ReporterEventInput[] = [];
  const reporterService = {
    async trackEvents(nextEvents: ReporterEventInput[]) {
      events.push(...nextEvents);
    }
  };
  const runtime = createRuntimeHarness();
  const lifecycle = createWorkspaceWindowLifecycle(runtime);
  const scheduledPageviews = new Set<() => void>();
  startPredefinePageviewAnalytics({
    lifecycle,
    reporterService,
    scheduleFocusReport(listener) {
      scheduledPageviews.add(listener);
      return () => scheduledPageviews.delete(listener);
    }
  });
  startDesktopAgentAvailabilitySnapshotAnalytics({
    dependencies: { reporterService, storage: null },
    lifecycle,
    async refreshStatuses() {
      return [
        {
          actions: [],
          adapter: { command: [], installed: true },
          auth: { status: "authenticated" },
          availability: { status: "ready" },
          cli: { installed: true },
          provider: "codex",
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
        }
      ];
    }
  });

  lifecycle.start();
  await flushAsyncWork();
  runtime.emitFocus(2_000);
  for (const reportPageview of [...scheduledPageviews]) {
    reportPageview();
  }
  await flushAsyncWork();

  assert.deepEqual(
    events.map((event) => [event.name, event.clientTS]),
    [
      ["app.pageview", 1_000],
      ["agent.availability_snapshot", 1_000],
      ["app.pageview", 2_000],
      ["agent.availability_snapshot", 2_000]
    ]
  );
});

function createRuntimeHarness(): WorkspaceWindowLifecycleRuntime & {
  emitFocus(occurredAt: number): void;
} {
  let now = 1_000;
  const listeners = new Map<string, Set<() => void>>();
  const addListener = (type: string, listener: () => void): (() => void) => {
    const bucket = listeners.get(type) ?? new Set();
    bucket.add(listener);
    listeners.set(type, bucket);
    return () => bucket.delete(listener);
  };
  return {
    addDocumentListener: addListener,
    addWindowListener: addListener,
    emitFocus(occurredAt) {
      now = occurredAt;
      for (const listener of [...(listeners.get("focus") ?? [])]) {
        listener();
      }
    },
    hasFocus: () => true,
    now: () => now,
    visibilityState: () => "visible"
  };
}

async function flushAsyncWork(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
