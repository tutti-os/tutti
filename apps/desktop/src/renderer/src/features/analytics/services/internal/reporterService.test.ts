import assert from "node:assert/strict";
import test from "node:test";
import type { TrackEvent } from "@tutti-os/client-tuttid-ts";
import { ReporterService } from "./reporterService.ts";

test("reporter service tracks one renderer event with a client timestamp", async () => {
  const calls: TrackEvent[][] = [];
  const service = new ReporterService({
    tuttidClient: {
      async trackEvents(events) {
        calls.push(events);
      }
    },
    mode: "agent",
    now: () => 1749124800000
  });

  await service.track("workspace.opened", {
    dark_mode: "1",
    source: "dashboard"
  });

  assert.deepEqual(calls, [
    [
      {
        client_ts: 1749124800000,
        name: "workspace.opened",
        params: {
          dark_mode: "1",
          mode: "agent",
          source: "dashboard"
        }
      }
    ]
  ]);
});

test("reporter service tracks batches without mutating caller params", async () => {
  const params = { mode: "agent", source: "dock" };
  const calls: TrackEvent[][] = [];
  const service = new ReporterService({
    tuttidClient: {
      async trackEvents(events) {
        calls.push(structuredClone(events));
        events[0]!.params = { source: "mutated" };
      }
    },
    mode: "os",
    now: () => 1749124800001
  });

  await service.trackEvents([
    {
      clientTS: 1749124800000,
      name: "workspace.opened",
      params
    },
    {
      name: "screen.viewed"
    }
  ]);

  assert.deepEqual(calls, [
    [
      {
        client_ts: 1749124800000,
        name: "workspace.opened",
        params: {
          mode: "os",
          source: "dock"
        }
      },
      {
        client_ts: 1749124800001,
        name: "screen.viewed",
        params: {
          mode: "os"
        }
      }
    ]
  ]);
  assert.deepEqual(params, { mode: "agent", source: "dock" });
});

test("reporter service swallows transport failures", async () => {
  const service = new ReporterService({
    tuttidClient: {
      async trackEvents() {
        throw new Error("tuttid offline");
      }
    },
    mode: "os",
    now: () => 1749124800000
  });

  await assert.doesNotReject(() => service.track("workspace.opened"));
});
