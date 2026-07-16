import assert from "node:assert/strict";
import test from "node:test";
import type { TrackEvent } from "@tutti-os/client-tuttid-ts";
import { AnalyticsDebugEventService } from "./analyticsDebugEventService.ts";

test("analytics debug event service records immutable snapshots and notifies listeners", () => {
  const service = new AnalyticsDebugEventService();
  const snapshots: TrackEvent[][] = [];
  const unsubscribe = service.subscribe(() => {
    snapshots.push(service.getSnapshot());
  });

  const params = { source: "dashboard" };
  service.recordEvents([
    {
      client_ts: 1749124800000,
      name: "workspace.opened",
      params
    }
  ]);
  params.source = "mutated";

  assert.deepEqual(service.getSnapshot(), [
    {
      client_ts: 1749124800000,
      name: "workspace.opened",
      params: {
        source: "dashboard"
      }
    }
  ]);
  assert.equal(snapshots.length, 1);

  service.clear();

  assert.deepEqual(service.getSnapshot(), []);
  assert.equal(snapshots.length, 2);

  unsubscribe();
  service.recordEvents([
    {
      client_ts: 1749124800001,
      name: "screen.viewed"
    }
  ]);

  assert.equal(snapshots.length, 2);
});

test("analytics debug event service records final daemon events from event stream", () => {
  let connectCalls = 0;
  let unsubscribeCalls = 0;
  let subscribedTopic = "";
  let listener: unknown = null;
  const service = new AnalyticsDebugEventService({
    eventStreamClient: {
      async connect() {
        connectCalls++;
      },
      subscribe(topic, nextListener) {
        subscribedTopic = topic;
        listener = nextListener;
        return () => {
          unsubscribeCalls += 1;
        };
      }
    }
  });

  emitDebugReportedEvent(listener, {
    payload: {
      events: [
        {
          clientTs: 1749124800000,
          name: "workspace.opened",
          params: {
            app_version: "0.0.0",
            device_id: "device-1",
            os: "darwin",
            session_id: "session-1",
            source: "dashboard"
          }
        }
      ]
    }
  });

  assert.equal(connectCalls, 1);
  assert.equal(subscribedTopic, "analytics.debug.reported");
  assert.deepEqual(service.getSnapshot(), [
    {
      client_ts: 1749124800000,
      name: "workspace.opened",
      params: {
        app_version: "0.0.0",
        device_id: "device-1",
        os: "darwin",
        session_id: "session-1",
        source: "dashboard"
      }
    }
  ]);
  service.dispose();
  service.dispose();
  assert.equal(unsubscribeCalls, 1);
});

function emitDebugReportedEvent(
  listener: unknown,
  event: {
    payload: {
      events: readonly {
        clientTs: number;
        name: string;
        params: Record<string, unknown>;
      }[];
    };
  }
): void {
  if (typeof listener !== "function") {
    assert.fail("analytics debug event stream listener was not registered");
  }
  listener(event);
}
