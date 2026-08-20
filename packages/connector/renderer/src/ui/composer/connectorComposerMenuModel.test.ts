import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeConnectorItems,
  type ConnectorComposerItem
} from "./ConnectorComposerMenu.tsx";

test("orders installed connectors by installation time and preserves catalog order for legacy entries", () => {
  const items: ConnectorComposerItem[] = [
    item(" github "),
    item("figma", "connected", false, 200),
    item("notion", "connected", true, 300),
    item("legacy", "disabled"),
    item("github"),
    item("lark"),
    item("   ")
  ];

  assert.deepEqual(
    normalizeConnectorItems(items).map((entry) => entry.connectorKey),
    ["notion", "figma", "legacy", "github", "lark"]
  );
});

function item(
  connectorKey: string,
  status: ConnectorComposerItem["status"] = "setup_required",
  selected = false,
  installedAtUnixMs?: number
): ConnectorComposerItem {
  return {
    connectorKey,
    name: connectorKey,
    selected,
    installedAtUnixMs,
    status
  };
}
