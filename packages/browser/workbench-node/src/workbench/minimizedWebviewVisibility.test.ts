import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { shouldHideBrowserNodeWebview } from "../react/webviewVisibility.ts";

test("BrowserNode hides webviews for node-level and host-window minimization", () => {
  assert.equal(
    shouldHideBrowserNodeWebview({
      hidden: false,
      isHostMinimizing: false
    }),
    false
  );
  assert.equal(
    shouldHideBrowserNodeWebview({
      hidden: true,
      isHostMinimizing: false
    }),
    true
  );
  assert.equal(
    shouldHideBrowserNodeWebview({
      hidden: false,
      isHostMinimizing: true
    }),
    true
  );
});

test("browser workbench nodes pass minimized state to BrowserNode", () => {
  const workbenchSource = readFileSync(
    new URL("./index.ts", import.meta.url),
    "utf8"
  );
  const workspaceAppSource = readFileSync(
    new URL(
      "../../../../../apps/desktop/src/renderer/src/features/workspace-app-center/services/internal/workspaceAppCenterContribution.tsx",
      import.meta.url
    ),
    "utf8"
  );
  const browserNodeSource = readFileSync(
    new URL("../react/BrowserNode.tsx", import.meta.url),
    "utf8"
  );

  assert.match(workbenchSource, /hidden:\s*context\.node\.isMinimized/);
  assert.match(workspaceAppSource, /hidden=\{context\.node\.isMinimized\}/);
  assert.match(
    browserNodeSource,
    /shouldHideBrowserNodeWebview\(\{\s*hidden,\s*isHostMinimizing\s*\}\)\s*&&\s*"invisible"/
  );
});
