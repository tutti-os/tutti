import assert from "node:assert/strict";
import test from "node:test";
import type { TuttidEventStreamClient } from "@tutti-os/client-tuttid-ts";
import { createDesktopConnectorMarketEvents } from "./desktopConnectorMarketEvents.ts";

test("desktop connector market events map the unscoped daemon event", () => {
  let subscribedTopic = "";
  let subscribedOptions: unknown;
  let daemonListener: ((event: unknown) => void) | undefined;
  let unsubscribed = false;
  const eventClient = {
    subscribe(
      topic: string,
      listener: (event: unknown) => void,
      options: unknown
    ) {
      subscribedTopic = topic;
      subscribedOptions = options;
      daemonListener = listener;
      return () => {
        unsubscribed = true;
      };
    },
    subscribeConnectionState() {
      return () => {};
    }
  } as unknown as Pick<
    TuttidEventStreamClient,
    "subscribe" | "subscribeConnectionState"
  >;
  const received: unknown[] = [];

  const unsubscribe = createDesktopConnectorMarketEvents(eventClient).subscribe(
    (event) => received.push(event)
  );
  daemonListener?.({
    payload: {
      connectorKey: "notion",
      operationId: "operation-1",
      revision: 11
    }
  });

  assert.equal(subscribedTopic, "connector.market.changed");
  assert.deepEqual(subscribedOptions, { scope: null });
  assert.deepEqual(received, [
    {
      type: "connector.market.changed",
      connectorKey: "notion",
      operationId: "operation-1",
      revision: 11
    }
  ]);
  unsubscribe();
  assert.equal(unsubscribed, true);
});
