import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeConnectorItems,
  type ConnectorComposerItem
} from "./ConnectorComposerMenu.tsx";

test("orders installed authorized connectors first, then by installation event", () => {
  const items: ConnectorComposerItem[] = [
    item(" github "),
    item("cloudflare", "authorization_required", false, 900),
    item("figma", "connected", false, 200),
    item("notion", "connected", true, 300),
    item("legacy", "disabled"),
    item("github"),
    item("hubspot", "authorization_required", false, 400),
    item("lark"),
    item("   ")
  ];

  assert.deepEqual(
    normalizeConnectorItems(items).map((entry) => entry.connectorKey),
    ["notion", "figma", "legacy", "cloudflare", "hubspot", "github", "lark"]
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
