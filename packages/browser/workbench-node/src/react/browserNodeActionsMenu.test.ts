import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const actionsMenuSource = readFileSync(
  resolve(currentDirectory, "BrowserNodeActionsMenu.tsx"),
  "utf8"
);
const browserNodeSource = readFileSync(
  resolve(currentDirectory, "BrowserNode.tsx"),
  "utf8"
);
const browserNodeChromeSource = readFileSync(
  resolve(currentDirectory, "BrowserNodeChrome.tsx"),
  "utf8"
);

test("Browser Node actions render inline without a portal", () => {
  assert.match(actionsMenuSource, /<MenuSurface/);
  assert.doesNotMatch(
    actionsMenuSource,
    /(?:DropdownMenu|ViewportMenuSurface)(?:Content|Sub|Trigger)?/
  );
  assert.match(
    actionsMenuSource,
    /const hostOverlayOpen = clearDialogOpen \|\| settingsOpen/
  );
  assert.doesNotMatch(actionsMenuSource, /hostOverlayOpen = menuOpen/);
});

test("Browser Node nested actions stay inside one host menu surface", () => {
  for (const panel of ["find", "device", "screenshot", "downloads"]) {
    assert.match(actionsMenuSource, new RegExp(`menuPanel === "${panel}"`));
  }
});

test("Browser Node shares its inline actions menu with clipping Workbench headers", () => {
  assert.match(browserNodeSource, /<BrowserNodeChrome/);
  assert.equal(
    browserNodeChromeSource.match(/<BrowserNodeActionsMenu(?=\s)/g)?.length,
    1
  );
  assert.match(
    browserNodeChromeSource,
    /data-workbench-custom-header-overflow="visible"/
  );
});

test("Browser Node chrome keeps tabs above the address bar", () => {
  const tabStripIndex = browserNodeChromeSource.indexOf(
    'data-browser-node-tab-strip="true"'
  );
  const navigationIndex = browserNodeChromeSource.indexOf(
    'data-browser-node-navigation-bar="true"'
  );

  assert.ok(tabStripIndex >= 0);
  assert.ok(navigationIndex > tabStripIndex);
  assert.match(browserNodeChromeSource, /feature\.tabsStore\.addTab/);
  assert.match(browserNodeChromeSource, /closeBrowserNodeTab/);
});
