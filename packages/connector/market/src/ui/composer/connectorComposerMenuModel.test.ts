import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeConnectorItems,
  type ConnectorComposerItem
} from "./ConnectorComposerMenu.tsx";

test("normalizes connector keys while preserving catalog order and first identity", () => {
  const items: ConnectorComposerItem[] = [
    item(" github "),
    item("notion"),
    item("github"),
    item("   ")
  ];

  assert.deepEqual(
    normalizeConnectorItems(items).map((entry) => entry.connectorKey),
    ["github", "notion"]
  );
});

function item(connectorKey: string): ConnectorComposerItem {
  return {
    connectorKey,
    name: connectorKey,
    status: "setup_required"
  };
}
