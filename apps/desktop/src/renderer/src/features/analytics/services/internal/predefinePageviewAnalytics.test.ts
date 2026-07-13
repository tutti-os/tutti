import assert from "node:assert/strict";
import test from "node:test";
import type { ReporterEventInput } from "../reporterService.interface.ts";
import {
  startPredefinePageviewAnalytics,
  type PredefinePageviewAnalyticsRuntime
} from "./predefinePageviewAnalytics.ts";

test("predefine pageview analytics reports when the app opens", () => {
  const reporterCalls: ReporterEventInput[][] = [];
  const runtime = createRuntimeHarness();

  startPredefinePageviewAnalytics({
    reporterService: createReporterService(reporterCalls),
    reporterNow: () => runtime.now(),
    runtime
  });

  assert.deepEqual(reporterCalls, [
    [
      {
        clientTS: runtime.now(),
        name: "app.pageview"
      }
    ]
  ]);
});

test("predefine pageview analytics reports app opens before focus", () => {
  const reporterCalls: ReporterEventInput[][] = [];
  const runtime = createRuntimeHarness();

  startPredefinePageviewAnalytics({
    reporterService: createReporterService(reporterCalls),
    reporterNow: () => runtime.now(),
    runtime
  });
  runtime.emitFocus();
  runtime.flushFocusReports();

  assert.deepEqual(reporterCalls, [
    [
      {
        clientTS: runtime.now(),
        name: "app.pageview"
      }
    ],
    [
      {
        clientTS: runtime.now(),
        name: "app.pageview"
      }
    ]
  ]);
});

test("predefine pageview analytics reports every explicit focus", () => {
  const reporterCalls: ReporterEventInput[][] = [];
  const runtime = createRuntimeHarness();

  startPredefinePageviewAnalytics({
    reporterService: createReporterService(reporterCalls),
    reporterNow: () => runtime.now(),
    runtime
  });
  runtime.emitFocus();
  runtime.emitFocus();
  runtime.flushFocusReports();

  assert.deepEqual(
    reporterCalls.map((call) => call[0]?.name),
    ["app.pageview", "app.pageview", "app.pageview"]
  );
});

test("predefine pageview analytics reports focus after time changes", () => {
  const reporterCalls: ReporterEventInput[][] = [];
  const runtime = createRuntimeHarness();

  startPredefinePageviewAnalytics({
    reporterService: createReporterService(reporterCalls),
    reporterNow: () => runtime.now(),
    runtime
  });
  runtime.emitFocus();
  runtime.flushFocusReports();
  runtime.advanceTo(new Date(2026, 5, 10, 10, 0, 0).getTime());
  runtime.emitFocus();
  runtime.flushFocusReports();

  assert.deepEqual(
    reporterCalls.map((call) => call[0]?.name),
    ["app.pageview", "app.pageview", "app.pageview"]
  );
});

test("predefine pageview analytics cancels pending focus reports on dispose", () => {
  const reporterCalls: ReporterEventInput[][] = [];
  const runtime = createRuntimeHarness();

  const controller = startPredefinePageviewAnalytics({
    reporterService: createReporterService(reporterCalls),
    reporterNow: () => runtime.now(),
    runtime
  });
  runtime.emitFocus();
  controller.dispose();
  runtime.flushFocusReports();

  assert.deepEqual(
    reporterCalls.map((call) => call[0]?.name),
    ["app.pageview"]
  );
});

function createReporterService(calls: ReporterEventInput[][] = []) {
  return {
    async trackEvents(events: ReporterEventInput[]) {
      calls.push(events);
    }
  };
}

function createRuntimeHarness(input: { now?: number } = {}) {
  let now = input.now ?? new Date(2026, 5, 9, 10, 0, 0).getTime();
  const focusListeners = new Set<() => void>();
  const focusReports = new Set<() => void>();
  const runtime: PredefinePageviewAnalyticsRuntime & {
    advanceTo(nextNow: number): void;
    emitFocus(): void;
    flushFocusReports(): void;
    now(): number;
  } = {
    addFocusListener(listener) {
      focusListeners.add(listener);
      return () => {
        focusListeners.delete(listener);
      };
    },
    advanceTo(nextNow) {
      now = nextNow;
    },
    emitFocus() {
      for (const listener of [...focusListeners]) {
        listener();
      }
    },
    flushFocusReports() {
      const reports = [...focusReports];
      focusReports.clear();
      for (const report of reports) {
        report();
      }
    },
    now() {
      return now;
    },
    scheduleFocusReport(listener) {
      focusReports.add(listener);
      return () => {
        focusReports.delete(listener);
      };
    }
  };
  return runtime;
}
