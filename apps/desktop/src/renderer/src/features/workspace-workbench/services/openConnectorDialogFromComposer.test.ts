import assert from "node:assert/strict";
import test from "node:test";
import type { ConnectorMarketRootService } from "@tutti-os/connector-market/services";
import { openConnectorDialogFromComposer } from "./openConnectorDialogFromComposer.ts";

test("composer connector open loads the market and opens its canonical dialog", async () => {
  const calls: string[] = [];
  const root = createRoot(true, calls);

  const result = await openConnectorDialogFromComposer(root, " github ");

  assert.equal(result, "dialog-opened");
  assert.deepEqual(calls, ["load", "open:github"]);
});

test("composer connector open ignores missing catalog entries", async () => {
  const calls: string[] = [];
  const root = createRoot(false, calls);

  const result = await openConnectorDialogFromComposer(root, "github");

  assert.equal(result, "no-action");
  assert.deepEqual(calls, ["load"]);
});

function createRoot(
  hasConnector: boolean,
  calls: string[]
): ConnectorMarketRootService {
  return {
    market: {
      ensureLoaded: async () => {
        calls.push("load");
      }
    },
    view: {
      dataStore: {
        cardsByKey: hasConnector
          ? {
              github: { action: "install" }
            }
          : {}
      }
    },
    uiState: {
      openConnector: (connectorKey: string) => {
        calls.push(`open:${connectorKey}`);
      }
    }
  } as unknown as ConnectorMarketRootService;
}
