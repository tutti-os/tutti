import assert from "node:assert/strict";
import test from "node:test";
import { resolveCenteredWindowBounds } from "./workspaceWindowBounds.ts";

test("centered window bounds keep the default size when the work area has room", () => {
  assert.deepEqual(
    resolveCenteredWindowBounds({
      defaultHeight: 830,
      defaultWidth: 1340,
      margin: 48,
      minHeight: 520,
      minWidth: 760,
      workArea: { height: 1000, width: 1600, x: 0, y: 24 }
    }),
    { height: 830, width: 1340, x: 130, y: 109 }
  );
});

test("centered window bounds shrink to fit small work areas before centering", () => {
  assert.deepEqual(
    resolveCenteredWindowBounds({
      defaultHeight: 830,
      defaultWidth: 1340,
      margin: 48,
      minHeight: 520,
      minWidth: 760,
      workArea: { height: 760, width: 1440, x: 0, y: 25 }
    }),
    { height: 664, width: 1340, x: 50, y: 73 }
  );
});

test("centered window bounds stay inside the work area when the minimum is larger than available space", () => {
  assert.deepEqual(
    resolveCenteredWindowBounds({
      defaultHeight: 830,
      defaultWidth: 1340,
      margin: 48,
      minHeight: 520,
      minWidth: 760,
      workArea: { height: 480, width: 700, x: 10, y: 30 }
    }),
    { height: 520, width: 760, x: 10, y: 30 }
  );
});
