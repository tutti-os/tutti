import assert from "node:assert/strict";
import test from "node:test";
import type { WorkbenchFrame } from "@tutti-os/workbench-surface";
import { resolveDesktopAgentGUIEmbeddedDesktopSize } from "./desktopAgentGUIEmbeddedFrame.ts";

test("embedded agent GUI desktop size ignores the outer window position", () => {
  const frame: WorkbenchFrame = {
    height: 640,
    width: 960,
    x: 320,
    y: 180
  };
  assert.deepEqual(resolveDesktopAgentGUIEmbeddedDesktopSize(frame), {
    height: 640,
    width: 960
  });
});
