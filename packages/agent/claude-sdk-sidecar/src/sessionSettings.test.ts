import assert from "node:assert/strict";
import test from "node:test";
import {
  querySettingsFromSessionSettings,
  sidecarSessionSettings
} from "./sessionSettings.ts";

test("plansDirectory can be configured by the host environment", () => {
  const settings = sidecarSessionSettings({
    env: {
      TUTTI_CLAUDE_PLANS_DIRECTORY: "."
    },
    settings: {}
  });

  assert.equal(settings.plansDirectory, ".");
  assert.deepEqual(querySettingsFromSessionSettings(settings), {
    plansDirectory: "."
  });
});

test("blank host plansDirectory keeps the Claude SDK default", () => {
  const settings = sidecarSessionSettings({
    env: {
      TUTTI_CLAUDE_PLANS_DIRECTORY: "   "
    }
  });

  assert.equal(settings.plansDirectory, "");
  assert.deepEqual(querySettingsFromSessionSettings(settings), {});
});

test("query create settings include effortLevel for the next resumed query", () => {
  assert.deepEqual(
    querySettingsFromSessionSettings({
      model: "",
      permissionModeId: "default",
      planMode: false,
      effort: "high",
      speed: "standard"
    }),
    {
      effortLevel: "high",
      fastMode: false
    }
  );
  assert.deepEqual(
    querySettingsFromSessionSettings({
      model: "",
      permissionModeId: "default",
      planMode: false,
      effort: "",
      speed: ""
    }),
    {}
  );
});
