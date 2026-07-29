import assert from "node:assert/strict";
import test from "node:test";

import {
  ReporterService,
  type AnalyticsTransportEvent
} from "./reporterService.ts";

test("adds timestamps and daemon transport parameters without mutating input", async () => {
  const calls: (readonly AnalyticsTransportEvent[])[] = [];
  const params = { mode: "agent", source: "dock" };
  const service = new ReporterService({
    transport: {
      async trackEvents(events) {
        calls.push(structuredClone(events));
      }
    },
    commonParams: { mode: "os" },
    now: () => 1749124800000
  });

  await service.trackEvents([
    {
      name: "workspace.opened",
      params
    },
    {
      clientTS: 1749124800001,
      name: "screen.viewed"
    }
  ]);

  assert.deepEqual(calls, [
    [
      {
        clientTS: 1749124800000,
        name: "workspace.opened",
        params: {
          mode: "os",
          source: "dock"
        }
      },
      {
        clientTS: 1749124800001,
        name: "screen.viewed",
        params: {
          mode: "os"
        }
      }
    ]
  ]);
  assert.deepEqual(params, { mode: "agent", source: "dock" });
});

test("swallows common parameter and transport failures", async () => {
  const commonFailure = new ReporterService({
    transport: {
      async trackEvents() {
        throw new Error("should not be reached");
      }
    },
    commonParams() {
      throw new Error("preferences unavailable");
    }
  });
  const transportFailure = new ReporterService({
    transport: {
      async trackEvents() {
        throw new Error("daemon offline");
      }
    }
  });

  await assert.doesNotReject(() => commonFailure.track("workspace.opened"));
  await assert.doesNotReject(() => transportFailure.track("workspace.opened"));
});
