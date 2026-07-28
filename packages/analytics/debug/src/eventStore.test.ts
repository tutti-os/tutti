import assert from "node:assert/strict";
import test from "node:test";

import { AnalyticsDebugEventStore } from "./eventStore.ts";

test("debug event store keeps immutable bounded snapshots", () => {
  const store = new AnalyticsDebugEventStore({ maxEvents: 2 });
  const params = {
    context: {
      source: "dashboard",
      tags: ["primary"]
    }
  };
  let notifications = 0;
  store.subscribe(() => {
    notifications++;
  });

  store.recordEvents([
    { clientTS: 1, name: "discarded.event" },
    { clientTS: 2, name: "workspace.opened", params },
    { clientTS: 3, name: "workspace.closed" }
  ]);
  params.context.source = "mutated";
  params.context.tags.push("mutated");

  assert.deepEqual(store.getSnapshot(), [
    {
      clientTS: 2,
      name: "workspace.opened",
      params: {
        context: {
          source: "dashboard",
          tags: ["primary"]
        }
      }
    },
    { clientTS: 3, name: "workspace.closed" }
  ]);
  const snapshot = store.getSnapshot();
  const storedContext = snapshot[0]?.params?.context;
  assert.ok(storedContext);
  assert.throws(() => {
    (storedContext as { source: string }).source = "consumer mutation";
  }, TypeError);
  assert.deepEqual(store.getSnapshot(), snapshot);
  assert.equal(notifications, 1);
});

test("debug event store redacts before retaining events", () => {
  const store = new AnalyticsDebugEventStore({
    redact(event) {
      if (event.name === "private.event") {
        return null;
      }
      return {
        ...event,
        params: {
          ...event.params,
          token: "[redacted]"
        }
      };
    }
  });

  store.recordEvents([
    {
      clientTS: 1,
      name: "public.event",
      params: { token: "secret" }
    },
    {
      clientTS: 2,
      name: "private.event"
    }
  ]);

  assert.deepEqual(store.getSnapshot(), [
    {
      clientTS: 1,
      name: "public.event",
      params: { token: "[redacted]" }
    }
  ]);
});

test("debug event store isolates listener failures", () => {
  const store = new AnalyticsDebugEventStore();
  let notifications = 0;
  store.subscribe(() => {
    throw new Error("broken debug consumer");
  });
  store.subscribe(() => {
    notifications++;
  });

  assert.doesNotThrow(() => {
    store.recordEvents([{ clientTS: 1, name: "workspace.opened" }]);
  });
  assert.equal(notifications, 1);
});
