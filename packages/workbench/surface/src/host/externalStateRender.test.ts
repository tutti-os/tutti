import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const runtimeSource = readFileSync(
  resolve("src/host/useWorkbenchHostRuntime.ts"),
  "utf8"
);
const renderersSource = readFileSync(
  resolve("src/host/useWorkbenchHostSurfaceRenderers.tsx"),
  "utf8"
);
const hostSource = readFileSync(resolve("src/host/WorkbenchHost.tsx"), "utf8");

test("external state notifications invalidate host node body renderers", () => {
  assert.match(
    runtimeSource,
    /const \[externalStateRevision, bumpExternalStateRevision\] = useState\(0\);/
  );
  assert.match(runtimeSource, /externalStateRevision,/);
  assert.match(hostSource, /externalStateRevision,/);
  assert.match(renderersSource, /externalStateRevision: number;/);
  assert.match(
    renderersSource,
    /const renderNode = useCallback\([\s\S]*?input\.externalStateRevision,[\s\S]*?input\.hostSession/
  );
  assert.match(
    renderersSource,
    /const renderWindowHeader = useCallback\([\s\S]*?input\.externalStateRevision,[\s\S]*?input\.hostSession/
  );
});

test("node render errors do not leave an empty permanent fallback", () => {
  assert.match(
    renderersSource,
    /resetKey=\{`\$\{context\.node\.id\}:\$\{context\.node\.data\.typeId\}:\$\{input\.externalStateRevision\}`\}/
  );
  assert.match(
    renderersSource,
    /data-workbench-node-render-error-message="true"/
  );
  assert.match(renderersSource, /Try selecting another conversation/);
});
