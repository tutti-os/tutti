import assert from "node:assert/strict";
import test from "node:test";
import type { DesktopFusionWindowDescriptor } from "../../shared/contracts/fusion.ts";
import {
  assertFusionDockAccess,
  assertFusionOpenWindowAccess,
  assertFusionTargetWindowAccess,
  parseFusionOpenWindowInput,
  parseFusionUpdateWindowInput,
  parseFusionWindowTargetInput,
  requireFusionRendererAccess
} from "./fusionAccess.ts";

const descriptor: DesktopFusionWindowDescriptor = {
  createdAtUnixMs: 1,
  focused: false,
  kind: "browser",
  lastFocusedAtUnixMs: 0,
  resourceId: null,
  title: null,
  visibility: "visible",
  windowInstanceId: "window-a",
  workspaceId: "workspace-a"
};

test("Fusion IPC parsers accept typed inputs and normalize text", () => {
  assert.deepEqual(
    parseFusionOpenWindowInput({
      forceNew: true,
      kind: "browser",
      resourceId: " resource-a ",
      title: undefined,
      workspaceId: " workspace-a "
    }),
    {
      forceNew: true,
      kind: "browser",
      resourceId: "resource-a",
      workspaceId: "workspace-a"
    }
  );
  assert.deepEqual(
    parseFusionWindowTargetInput({ windowInstanceId: " window-a " }),
    { windowInstanceId: "window-a" }
  );
  assert.deepEqual(
    parseFusionUpdateWindowInput({
      title: null,
      windowInstanceId: "window-a"
    }),
    { title: null, windowInstanceId: "window-a" }
  );
});

test("Fusion IPC parsers reject malformed mutation payloads", () => {
  assert.throws(
    () =>
      parseFusionOpenWindowInput({
        forceNew: "yes",
        kind: "browser",
        workspaceId: "workspace-a"
      }),
    /forceNew/
  );
  assert.throws(
    () =>
      parseFusionOpenWindowInput({
        kind: "unknown",
        workspaceId: "workspace-a"
      }),
    /kind/
  );
  assert.throws(
    () => parseFusionWindowTargetInput({ windowInstanceId: 1 }),
    /windowInstanceId/
  );
  assert.throws(
    () =>
      parseFusionUpdateWindowInput({
        title: false,
        windowInstanceId: "window-a"
      }),
    /title/
  );
});

test("Fusion Dock access spans known workspace windows", () => {
  const dock = { kind: "dock" as const, workspaceId: "workspace-a" };
  assert.doesNotThrow(() =>
    assertFusionOpenWindowAccess(dock, {
      kind: "browser",
      workspaceId: "workspace-a"
    })
  );
  assert.doesNotThrow(() => assertFusionTargetWindowAccess(dock, descriptor));
  assert.doesNotThrow(() =>
    assertFusionOpenWindowAccess(dock, {
      kind: "browser",
      workspaceId: "workspace-b"
    })
  );
  assert.doesNotThrow(() =>
    assertFusionTargetWindowAccess(dock, {
      ...descriptor,
      workspaceId: "workspace-b"
    })
  );
});

test("Fusion tool windows can open same-workspace children but target only themselves", () => {
  const tool = {
    kind: "window" as const,
    windowInstanceId: "window-a",
    workspaceId: "workspace-a"
  };
  assert.doesNotThrow(() =>
    assertFusionOpenWindowAccess(tool, {
      kind: "file-preview",
      workspaceId: "workspace-a"
    })
  );
  assert.doesNotThrow(() => assertFusionTargetWindowAccess(tool, descriptor));
  assert.throws(
    () =>
      assertFusionOpenWindowAccess(tool, {
        kind: "browser",
        workspaceId: "workspace-b"
      }),
    /cross-workspace/
  );
  assert.throws(
    () =>
      assertFusionTargetWindowAccess(tool, {
        ...descriptor,
        workspaceId: "workspace-b"
      }),
    /cross-workspace/
  );
  assert.throws(
    () =>
      assertFusionTargetWindowAccess(tool, {
        ...descriptor,
        windowInstanceId: "window-b"
      }),
    /only operate on themselves/
  );
  assert.throws(
    () => assertFusionTargetWindowAccess(tool, null),
    /unavailable/
  );
  assert.throws(() => assertFusionDockAccess(tool), /restricted to the Dock/);
});

test("Fusion IPC rejects unregistered renderers", () => {
  assert.throws(() => requireFusionRendererAccess(null), /not a registered/);
});
