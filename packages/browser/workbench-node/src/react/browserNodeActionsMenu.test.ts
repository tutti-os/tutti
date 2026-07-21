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
const chromeProfileAvatarSource = readFileSync(
  resolve(currentDirectory, "BrowserNodeChromeProfileAvatar.tsx"),
  "utf8"
);
const chromeImportPromptSource = readFileSync(
  resolve(currentDirectory, "BrowserNodeChromeImportPrompt.tsx"),
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

test("Chrome import prompt occupies Browser content layout and excludes incognito", () => {
  assert.match(browserNodeSource, /<BrowserNodeChromeImportPrompt/);
  assert.match(
    browserNodeSource,
    /isChromeCookieImportEligible\(\{ sessionMode, sessionPartition \}\)/
  );
  assert.match(
    browserNodeSource,
    /<BrowserNodeChromeImportPrompt[\s\S]*?<div className="relative min-h-0 flex-1/
  );
});

test("Chrome Profile avatar consumes the renderer-safe data URL contract", () => {
  assert.match(
    chromeProfileAvatarSource,
    /chromeProfileAvatarDataUrl\(profile\)/
  );
  assert.match(chromeProfileAvatarSource, /src=\{avatarDataUrl\}/);
  assert.match(chromeProfileAvatarSource, /<ChromeIcon/);
});

test("Chrome import prompt reports foreground aggregate results", () => {
  assert.match(chromeImportPromptSource, /onResult=\{\(result\) =>/);
  assert.match(
    chromeImportPromptSource,
    /browserNodeCookieImportFeedback\(feature, result\)/
  );
  for (const tone of ["success", "error", "warning"]) {
    assert.match(chromeImportPromptSource, new RegExp(`toast\\.${tone}`));
  }
});

test("Browser Node selected tab uses the fronted background and line-2 border", () => {
  assert.match(
    browserNodeChromeSource,
    /active\s*\? "border-\[var\(--line-2\)\] bg-\[var\(--background-fronted\)\] text-\[var\(--text-primary\)\] shadow-sm"/
  );
});

test("Browser Node address-bar icon actions use shared hover tooltips", () => {
  assert.match(
    browserNodeChromeSource,
    /<TooltipTrigger asChild>[\s\S]*?<Button[\s\S]*?<TooltipContent side="bottom">\{label\}<\/TooltipContent>/
  );
  assert.match(
    actionsMenuSource,
    /<TooltipTrigger asChild>[\s\S]*?<Button[\s\S]*?<TooltipContent side="bottom">[\s\S]*?actions\.more/
  );
});

test("Browser Node keeps cold lifecycle state internal", () => {
  assert.doesNotMatch(browserNodeChromeSource, /runtime\.lifecycle === "cold"/);
  assert.doesNotMatch(browserNodeChromeSource, /coldStatus/);
});
