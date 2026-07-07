import assert from "node:assert/strict";
import test from "node:test";
import { desktopAgentComposerDefaultsEqual } from "./desktopAgentComposerDefaultsWriteGate.ts";

test("desktopAgentComposerDefaultsEqual compares normalized default values", () => {
  assert.equal(
    desktopAgentComposerDefaultsEqual(
      {
        model: " gpt-5.5 ",
        permissionModeId: " full-access ",
        reasoningEffort: " high "
      },
      {
        model: "gpt-5.5",
        permissionModeId: "full-access",
        reasoningEffort: "high"
      }
    ),
    true
  );
  assert.equal(
    desktopAgentComposerDefaultsEqual(
      { permissionModeId: "auto" },
      { permissionModeId: "full-access" }
    ),
    false
  );
});
