import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("./workspaceTerminalContribution.ts", import.meta.url),
  "utf8"
);
const factorySource = readFileSync(
  new URL(
    "./contributions/terminalWorkbenchContributionFactory.ts",
    import.meta.url
  ),
  "utf8"
);

test("workspace terminal window injects unified traffic lights into the package header", () => {
  assert.match(source, /defaultActions: input\.renderTrafficLights\(context\)/);
  assert.match(factorySource, /WorkspaceWorkbenchTrafficLights/);
  assert.match(
    factorySource,
    /createElement\([\s\S]*WorkspaceWorkbenchTrafficLights[\s\S]*displayMode: headerContext\.displayMode[\s\S]*windowActions: headerContext\.windowActions/
  );
});
