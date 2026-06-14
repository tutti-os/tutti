import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("./internal/project/WorkspaceUserProjectSelect.tsx", import.meta.url),
  "utf8"
);

test("workspace user project labels marquee overflowing text on hover", () => {
  assert.match(source, /@keyframes workspace-user-project-label-marquee/);
  assert.match(source, /container-type:\s*inline-size;/);
  assert.match(
    source,
    /\.workspace-user-project-overflow-label:hover\s+\.workspace-user-project-overflow-label__content\s*{[^}]*animation:\s*workspace-user-project-label-marquee 14s linear infinite;/s
  );
  assert.match(
    source,
    /transform:\s*translateX\(min\(0px,\s*calc\(100cqw - 100%\)\)\);/
  );
  assert.match(
    source,
    /@media \(prefers-reduced-motion:\s*reduce\)\s*{[\s\S]*animation:\s*none;[\s\S]*}/
  );
});
