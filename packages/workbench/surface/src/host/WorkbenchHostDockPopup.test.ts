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
