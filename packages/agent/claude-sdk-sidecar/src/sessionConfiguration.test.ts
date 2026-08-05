import assert from "node:assert/strict";
import test from "node:test";
import { SessionConfiguration } from "./sessionConfiguration.ts";

test("switching to Default clears the previous effective model without pinning it", async () => {
  const setModelCalls: Array<string | undefined> = [];
  const settings = {
    model: "sonnet",
    permissionModeId: "default",
    planMode: false,
    effort: "",
    speed: ""
  };
  const configuration = new SessionConfiguration({
    settings,
    getQuery: () => ({
      setModel: async (model) => {
        setModelCalls.push(model);
      }
    }),
    testDriver: false,
    isInitialized: () => true,
    markInitialized: () => {},
    emitFastModeState: () => {}
  });
  configuration.applyInitializationResult({
    models: [
      { value: "default", displayName: "Sonnet 5" },
      { value: "sonnet", displayName: "Sonnet 5" },
      { value: "opus", displayName: "Opus 4.8" }
    ]
  });
  configuration.applyRuntimeModel("claude-sonnet-5");

  await configuration.apply({ model: "default" });

  assert.equal(settings.model, "default");
  assert.deepEqual(setModelCalls, [undefined]);
  const modelOption = (
    configuration.sessionStatePayload().configOptions as Array<
      Record<string, unknown>
    >
  ).find((option) => option.id === "model");
  assert.equal(modelOption?.currentValue, "default");
  assert.equal(Object.hasOwn(modelOption ?? {}, "effectiveValue"), false);

  configuration.applyRuntimeModel("claude-opus-4-8");
  const updatedModelOption = (
    configuration.sessionStatePayload().configOptions as Array<
      Record<string, unknown>
    >
  ).find((option) => option.id === "model");
  assert.equal(updatedModelOption?.currentValue, "default");
  assert.equal(updatedModelOption?.effectiveValue, "claude-opus-4-8");
});

test("absorbPendingFlagsIntoQueryCreate clears pending without live applyFlagSettings", async () => {
  const applyFlagSettingsCalls: unknown[] = [];
  const fastModeStates: Array<"on" | "off"> = [];
  const settings = {
    model: "",
    permissionModeId: "default",
    planMode: false,
    effort: "medium",
    speed: "standard"
  };
  let queryAvailable = false;
  const configuration = new SessionConfiguration({
    settings,
    getQuery: () =>
      queryAvailable
        ? {
            applyFlagSettings: async (value) => {
              applyFlagSettingsCalls.push(value);
            }
          }
        : undefined,
    testDriver: false,
    isInitialized: () => true,
    markInitialized: () => {},
    emitFastModeState: (state) => {
      fastModeStates.push(state);
    }
  });

  // Mirror apply_settings after idle-retire: no live query, pending retained.
  await configuration.apply({ effort: "high", speed: "fast" });
  assert.equal(settings.effort, "high");
  assert.equal(settings.speed, "fast");
  assert.deepEqual(applyFlagSettingsCalls, []);

  configuration.absorbPendingFlagsIntoQueryCreate();
  queryAvailable = true;
  await configuration.applyPendingFlags();

  assert.deepEqual(applyFlagSettingsCalls, []);
  assert.deepEqual(fastModeStates, ["on"]);
});
