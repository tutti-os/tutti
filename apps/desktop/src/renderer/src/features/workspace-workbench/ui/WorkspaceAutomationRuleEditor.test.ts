import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const source = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "WorkspaceAutomationRuleEditor.tsx"
  ),
  "utf8"
);

test("permission mode select falls back to the target-default sentinel for unresolved modes", () => {
  // A draft permission mode the rendered catalog does not offer (target just
  // switched and the new catalog is loading, or the load failed) must render
  // the "use the target Agent's default" sentinel instead of empty trigger
  // text, so the select value goes through the fallback resolver rather than
  // the raw draft value.
  assert.match(source, /function permissionModeSelectValue\(/);
  assert.match(
    source,
    /value=\{permissionModeSelectValue\(\s*draft\.permissionModeId,\s*catalogReady,\s*targetCatalog\?\.permissionModes \?\? \[\]\s*\)\}/
  );
  assert.doesNotMatch(
    source,
    /value=\{draft\.permissionModeId \|\| DEFAULT_PERMISSION_MODE_VALUE\}/
  );
});

test("permission mode fallback resolver only trusts a ready catalog", () => {
  const helper = source.slice(
    source.indexOf("function permissionModeSelectValue("),
    source.indexOf("export interface WorkspaceAutomationRuleEditorProps")
  );
  assert.match(helper, /catalogReady &&/);
  assert.match(
    helper,
    /permissionModes\.some\(\(mode\) => mode\.id === permissionModeId\)/
  );
  assert.match(helper, /return DEFAULT_PERMISSION_MODE_VALUE;/);
});
