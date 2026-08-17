import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(
  resolve(directory, "WorkspaceChromeActions.tsx"),
  "utf8"
);

test("Windows help menu exposes the shared desktop update check", () => {
  assert.match(source, /useAppUpdateService\(\)/);
  assert.match(source, /void appUpdateService\.checkForUpdates\(\)/);
  assert.match(source, /t\("desktop\.menu\.checkForUpdates"\)/);
  assert.match(
    source,
    /disabled=\{appUpdateState\.isActing\}[\s\S]{0,220}updates\.checkingTitle/
  );
});
