import assert from "node:assert/strict";
import test from "node:test";
import { agentGuiWorkbenchSelectConnectorActivationType } from "@tutti-os/agent-gui/workbench/types";
import { resolveDesktopAgentGUIConnectorSelectionActivation } from "./desktopAgentGUIConnectorSelectionActivation.ts";

test("maps an exact connector activation to one composer append request", () => {
  assert.deepEqual(
    resolveDesktopAgentGUIConnectorSelectionActivation({
      payload: { connectorKey: " notion " },
      sequence: 7,
      type: agentGuiWorkbenchSelectConnectorActivationType
    }),
    { connectorKey: "notion", sequence: 7 }
  );
});

test("rejects unrelated and empty connector activations", () => {
  assert.equal(
    resolveDesktopAgentGUIConnectorSelectionActivation({
      payload: { connectorKey: "notion" },
      sequence: 7,
      type: "agent-gui:other"
    }),
    null
  );
  assert.equal(
    resolveDesktopAgentGUIConnectorSelectionActivation({
      payload: { connectorKey: " " },
      sequence: 8,
      type: agentGuiWorkbenchSelectConnectorActivationType
    }),
    null
  );
});
