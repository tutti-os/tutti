import assert from "node:assert/strict";
import test from "node:test";
import type {
  WorkspaceWindowLifecycle,
  WorkspaceWindowLifecycleEvent
} from "../../../../lib/workspaceWindowLifecycle.ts";
import type { ReporterEventInput } from "../reporterService.interface.ts";
import { startPredefinePageviewAnalytics } from "./predefinePageviewAnalytics.ts";

test("predefine pageview analytics reports opened and every focus", () => {
  const reporterCalls: ReporterEventInput[][] = [];
  const lifecycle = createLifecycleHarness();
  const scheduledReports = new Set<() => void>();

  startPredefinePageviewAnalytics({
    lifecycle,
    reporterService: createReporterService(reporterCalls),
    scheduleFocusReport(listener) {
      scheduledReports.add(listener);
      return () => scheduledReports.delete(listener);
    }
  });

  lifecycle.emit({ kind: "opened", occurredAt: 1_000 });
  lifecycle.emit({ kind: "focused", occurredAt: 2_000 });
  lifecycle.emit({ kind: "focused", occurredAt: 3_000 });

  assert.deepEqual(reporterCalls, [
    [{ clientTS: 1_000, name: "app.pageview" }]
  ]);

  for (const report of [...scheduledReports]) {
    report();
  }

  assert.deepEqual(reporterCalls, [
    [{ clientTS: 1_000, name: "app.pageview" }],
    [{ clientTS: 2_000, name: "app.pageview" }],
    [{ clientTS: 3_000, name: "app.pageview" }]
  ]);
});

test("predefine pageview analytics cancels pending focus reports on dispose", () => {
  const reporterCalls: ReporterEventInput[][] = [];
  const lifecycle = createLifecycleHarness();
  const scheduledReports = new Set<() => void>();
  const controller = startPredefinePageviewAnalytics({
    lifecycle,
    reporterService: createReporterService(reporterCalls),
    scheduleFocusReport(listener) {
      scheduledReports.add(listener);
      return () => scheduledReports.delete(listener);
    }
  });

  lifecycle.emit({ kind: "opened", occurredAt: 1_000 });
  lifecycle.emit({ kind: "focused", occurredAt: 2_000 });
  controller.dispose();
  for (const report of [...scheduledReports]) {
    report();
  }
  lifecycle.emit({ kind: "focused", occurredAt: 3_000 });

  assert.deepEqual(reporterCalls, [
    [{ clientTS: 1_000, name: "app.pageview" }]
  ]);
});

function createReporterService(calls: ReporterEventInput[][]) {
  return {
    async trackEvents(events: ReporterEventInput[]) {
      calls.push(events);
    }
  };
}

function createLifecycleHarness(): WorkspaceWindowLifecycle & {
  emit(event: WorkspaceWindowLifecycleEvent): void;
} {
  const listeners = new Set<(event: WorkspaceWindowLifecycleEvent) => void>();
  return {
    emit(event) {
      for (const listener of [...listeners]) {
        listener(event);
      }
    },
    getSnapshot: () => ({ focused: true, visibility: "visible" }),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}
