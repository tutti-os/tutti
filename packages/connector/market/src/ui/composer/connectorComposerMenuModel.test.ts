import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeConnectorItems,
  type ConnectorComposerItem
} from "./ConnectorComposerMenu.tsx";

test("prioritizes connected connectors while preserving group order and first identity", () => {
  const items: ConnectorComposerItem[] = [
    item(" github "),
    item("notion", "connected"),
    item("github"),
    item("lark"),
    item("figma", "connected"),
    item("   ")
  ];

  assert.deepEqual(
    normalizeConnectorItems(items).map((entry) => entry.connectorKey),
    ["notion", "figma", "github", "lark"]
  );
});

function item(
  connectorKey: string,
  status: ConnectorComposerItem["status"] = "setup_required"
): ConnectorComposerItem {
  return {
    connectorKey,
    name: connectorKey,
    status
  };
}
