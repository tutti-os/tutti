import assert from "node:assert/strict";
import test from "node:test";

import {
  BaseAnalyticsReporter,
  type AnalyticsReporterDependencies
} from "./baseReporter.ts";
import type { ReporterEventInput } from "./reporterService.ts";

test("base analytics reporter normalizes parameter names without owning event semantics", async () => {
  const calls: ReporterEventInput[][] = [];

  class WorkspaceOpenedReporter extends BaseAnalyticsReporter<{
    entrySource: string;
    firstOpen: boolean;
  }> {
    protected readonly eventName = "workspace.opened";

    constructor(
      params: { entrySource: string; firstOpen: boolean },
      dependencies: AnalyticsReporterDependencies
    ) {
      super(params, dependencies);
    }
  }

  const dependencies: AnalyticsReporterDependencies = {
    now: () => 1749124800000,
    reporterService: {
      async trackEvents(events) {
        calls.push(events);
      }
    }
  };
  await new WorkspaceOpenedReporter(
    {
      entrySource: "dock",
      firstOpen: true
    },
    dependencies
  ).report();

  assert.deepEqual(calls, [
    [
      {
        clientTS: 1749124800000,
        name: "workspace.opened",
        params: {
          entry_source: "dock",
          first_open: true
        }
      }
    ]
  ]);
});
