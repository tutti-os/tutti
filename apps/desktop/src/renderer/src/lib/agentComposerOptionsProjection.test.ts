import assert from "node:assert/strict";
import test from "node:test";
import { agentActivityComposerOptionsFromTuttidResult } from "./agentComposerOptionsProjection.ts";

test("agent composer options keep SDK fast speed configurable after reload", () => {
  const options = agentActivityComposerOptionsFromTuttidResult("claude-code", {
    runtimeContext: {
      configOptions: [
        {
          id: "fast",
          currentValue: "fast",
          options: [
            { name: "Standard", value: "standard" },
            { name: "Fast", value: "fast" }
          ]
        }
      ]
    }
  });

  assert.equal(options.speedConfigurable, true);
  assert.deepEqual(options.speeds, [
    { label: "Standard", value: "standard" },
    { label: "Fast", value: "fast" }
  ]);
  const runtimeContext = options.runtimeContext;
  assert.ok(runtimeContext);
  assert.equal(
    (runtimeContext.configOptions as Array<Record<string, unknown>>)[0]
      ?.currentValue,
    "fast"
  );
});
