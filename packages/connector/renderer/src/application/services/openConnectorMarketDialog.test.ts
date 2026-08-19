import assert from "node:assert/strict";
import test from "node:test";

import type { IConnectorMarketRoot } from "./core/connectorMarketRoot.interface.ts";
import { openConnectorMarketDialog } from "./openConnectorMarketDialog.ts";

test("opens the canonical dialog only after the connector exists in the loaded view", async () => {
  const calls: string[] = [];
  const root = createRoot({
    ensureLoaded: async () => {
      calls.push("load");
      root.view.dataStore.cardsByKey.github = {} as never;
    },
    openConnector: (connectorKey) => calls.push(`open:${connectorKey}`)
  });

  const result = await openConnectorMarketDialog(root, " github ");

  assert.equal(result, "opened");
  assert.deepEqual(calls, ["load", "open:github"]);
});

test("does not open a dialog for invalid or unknown connector keys", async () => {
  let loadCount = 0;
  const opened: string[] = [];
  const root = createRoot({
    ensureLoaded: async () => {
      loadCount += 1;
    },
    openConnector: (connectorKey) => opened.push(connectorKey)
  });

  assert.equal(
    await openConnectorMarketDialog(root, "   "),
    "invalid-connector-key"
  );
  assert.equal(
    await openConnectorMarketDialog(root, "missing"),
    "connector-not-found"
  );
  assert.equal(loadCount, 1);
  assert.deepEqual(opened, []);
});

function createRoot(input: {
  ensureLoaded: () => Promise<void>;
  openConnector: (connectorKey: string) => void;
}): IConnectorMarketRoot {
  return {
    market: { ensureLoaded: input.ensureLoaded },
    uiState: { openConnector: input.openConnector },
    view: { dataStore: { cardsByKey: {} } }
  } as IConnectorMarketRoot;
}
