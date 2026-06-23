import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("./internal/project/WorkspaceUserProjectSelect.tsx", import.meta.url),
  "utf8"
);

test("workspace user project labels marquee overflowing text on hover", () => {
  assert.match(source, /@keyframes workspace-user-project-label-marquee/);
  assert.match(source, /container-type:\s*normal;/);
  assert.doesNotMatch(source, /container-type:\s*inline-size;/);
  assert.match(
    source,
    /--workspace-user-project-label-marquee-distance:\s*0px;/
  );
  assert.match(
    source,
    /transform:\s*translateX\(var\(--workspace-user-project-label-marquee-distance,\s*0px\)\);/
  );
  assert.match(
    source,
    /\.workspace-user-project-overflow-label\[data-overflow="true"\]:hover\s+\.workspace-user-project-overflow-label__content,\s+\[data-slot="select-item"\]:hover[\s\S]*?\{\s*animation:\s*workspace-user-project-label-marquee 14s linear infinite;/s
  );
  assert.match(
    source,
    /\[data-slot="select-item"\]:hover\s+\.workspace-user-project-overflow-label\[data-overflow="true"\]\s+\.workspace-user-project-overflow-label__content/
  );
  assert.doesNotMatch(
    source,
    /\[data-slot="select-item"\]\[data-highlighted\][\s\S]*workspace-user-project-label-marquee/
  );
  assert.match(source, /content\.scrollWidth - root\.clientWidth/);
  assert.match(source, /ResizeObserver/);
  assert.match(
    source,
    /@media \(prefers-reduced-motion:\s*reduce\)\s*{[\s\S]*animation:\s*none;[\s\S]*}/
  );
});

test("workspace user project select closes its portal when disabled", () => {
  assert.match(
    source,
    /useEffect\(\(\) => \{\s*if \(!disabled \|\| !isSelectOpen\) \{\s*return;\s*}\s*setIsSelectOpen\(false\);/s
  );
  assert.match(source, /\}, \[disabled, isSelectOpen\]\);/);
});

test("workspace user project select shows a visible action separator", () => {
  assert.match(source, /SelectSeparator/);
  assert.match(source, /data-workspace-user-project-action-separator="true"/);
  assert.match(source, /bg-\[var\(--line-2\)\]/);
});
