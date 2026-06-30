import assert from "node:assert/strict";
import test from "node:test";
import type { ReporterEventInput } from "../reporterService.interface.ts";
import {
  startPredefinePageviewAnalytics,
  type PredefinePageviewAnalyticsRuntime,
  type PredefinePageviewAnalyticsStorage
} from "./predefinePageviewAnalytics.ts";

test("predefine pageview analytics reports when the app opens", () => {
  const reporterCalls: ReporterEventInput[][] = [];
  const runtime = createRuntimeHarness();
  const storage = createStorageHarness();

  startPredefinePageviewAnalytics({
    reporterService: createReporterService(reporterCalls),
    reporterNow: () => runtime.now(),
    runtime,
    storage
  });

  assert.deepEqual(reporterCalls, [
    [
      {
        clientTS: runtime.now(),
        name: "predefine_pageview"
      }
    ]
  ]);
});

test("predefine pageview analytics reports app opens even after a focus report that day", () => {
  const reporterCalls: ReporterEventInput[][] = [];
  const runtime = createRuntimeHarness();
  const storage = createStorageHarness({
    focusedDay: "2026-06-09"
  });

  startPredefinePageviewAnalytics({
    reporterService: createReporterService(reporterCalls),
    reporterNow: () => runtime.now(),
    runtime,
    storage
  });

  assert.deepEqual(reporterCalls, [
    [
      {
        clientTS: runtime.now(),
        name: "predefine_pageview"
      }
    ]
  ]);
});

test("predefine pageview analytics reports explicit focus once per local day", () => {
  const reporterCalls: ReporterEventInput[][] = [];
  const runtime = createRuntimeHarness();
  const storage = createStorageHarness();

  startPredefinePageviewAnalytics({
    reporterService: createReporterService(reporterCalls),
    reporterNow: () => runtime.now(),
    runtime,
    storage
  });
  runtime.emitFocus();
  runtime.emitFocus();

  assert.deepEqual(
    reporterCalls.map((call) => call[0]?.name),
    ["predefine_pageview", "predefine_pageview"]
  );
});

test("predefine pageview analytics reports explicit focus again on a new local day", () => {
  const reporterCalls: ReporterEventInput[][] = [];
  const runtime = createRuntimeHarness();
  const storage = createStorageHarness();

  startPredefinePageviewAnalytics({
    reporterService: createReporterService(reporterCalls),
    reporterNow: () => runtime.now(),
    runtime,
    storage
  });
  runtime.emitFocus();
  runtime.advanceTo(new Date(2026, 5, 10, 10, 0, 0).getTime());
  runtime.emitFocus();

  assert.deepEqual(
    reporterCalls.map((call) => call[0]?.name),
    ["predefine_pageview", "predefine_pageview", "predefine_pageview"]
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
  const runtime: PredefinePageviewAnalyticsRuntime & {
    advanceTo(nextNow: number): void;
    emitFocus(): void;
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
    now() {
      return now;
    }
  };
  return runtime;
}

function createStorageHarness(input: { focusedDay?: string } = {}) {
  let focusedDay = input.focusedDay ?? null;
  return {
    getFocusedDay() {
      return focusedDay;
    },
    setFocusedDay(dayKey) {
      focusedDay = dayKey;
    }
  } satisfies PredefinePageviewAnalyticsStorage;
}
