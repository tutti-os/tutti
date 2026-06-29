import assert from "node:assert/strict";
import test from "node:test";
import {
  desktopAgentComposerDefaultsEqual,
  desktopAgentComposerOverridesToDefaults
} from "./desktopAgentComposerDefaultsWriteGate.ts";

test("desktopAgentComposerOverridesToDefaults keeps only durable composer defaults", () => {
  assert.deepEqual(
    desktopAgentComposerOverridesToDefaults({
      model: " gpt-5.5 ",
      permissionModeId: " full-access ",
      planMode: true,
      reasoningEffort: " high "
    }),
    {
      model: "gpt-5.5",
      permissionModeId: "full-access",
      reasoningEffort: "high"
    }
  );
});

test("desktopAgentComposerOverridesToDefaults returns null for empty defaults", () => {
  assert.equal(
    desktopAgentComposerOverridesToDefaults({
      planMode: true
    }),
    null
  );
});

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
