import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const source = readFileSync(
  resolve("src/host/WorkbenchHostDockPopup.tsx"),
  "utf8"
);

test("minimized stack popup cards disappear before restoring", () => {
  assert.match(source, /const dockPopupMinimizedStackLaunchDisappearMs = 0;/);
  assert.match(
    source,
    /const \[isLaunching, setIsLaunching\] = useState\(false\);/
  );
  assert.match(source, /data-launching=\{isLaunching \? "true" : undefined\}/);
  assert.match(
    source,
    /if \(!isMinimizedStack\) \{[\s\S]*?onSelectNode\(item\.node\.id\);/
  );
  assert.match(source, /setIsLaunching\(true\);/);
  assert.match(
    source,
    /setTimeout\(\(\) => \{[\s\S]*?onSelectNode\(item\.node\.id\);[\s\S]*?\}, dockPopupMinimizedStackLaunchDisappearMs\)/
  );
});

test("popup card refs are stable across renders", () => {
  assert.match(source, /const cardRefCallbacksRef = useRef/);
  assert.match(source, /cardRefCallbacksRef\.current\.get\(nodeId\)/);
  assert.match(source, /cardRefCallbacksRef\.current\.set\(nodeId, callback\)/);
  assert.doesNotMatch(
    source,
    /const registerCard = useCallback\(\s*\(nodeId: string\) => \(element: HTMLElement \| null\) =>/
  );
});

test("popup cards render component or image preview states", () => {
  assert.match(source, /WorkbenchHostDockPopupPreviewState/);
  assert.match(source, /status: "loading" \| "fallback"/);
  assert.match(source, /status: "ready"/);
  assert.match(source, /resolveDockPopupItemPreviewState/);
  assert.match(source, /preview\.kind === "component"/);
  assert.match(source, /src=\{preview\.src\}/);
  assert.match(source, /data-preview-state=\{previewState\.status\}/);
  assert.match(source, /bg-transparency-hover/);
  assert.doesNotMatch(source, /dockPopupLoadingPreviewImageUrl/);
  assert.doesNotMatch(source, /dockPopupFallbackPreviewImageUrl/);
});

test("popup preview memory cache is scoped by dock preview cache identity", () => {
  assert.match(source, /const dockPopupPreviewByMemoryKey = new Map/);
  assert.match(source, /const pendingDockPopupPreviewMemoryKeys = new Set/);
  assert.match(source, /function resolveDockPopupPreviewMemoryKey/);
  assert.match(source, /workspaceId: cacheKey\.workspaceId/);
  assert.match(source, /readDockPopupPreviewImage\(previewMemoryKey\)/);
  assert.match(
    source,
    /pendingDockPopupPreviewMemoryKeys\.has\(previewMemoryKey\)/
  );
  assert.doesNotMatch(source, /readDockPopupPreviewImage\(item\.node\.id\)/);
  assert.doesNotMatch(source, /pendingDockPopupPreviewNodeIDs/);
});
