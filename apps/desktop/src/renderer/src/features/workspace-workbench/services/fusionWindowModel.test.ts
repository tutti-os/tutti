import assert from "node:assert/strict";
import test from "node:test";
import type { DesktopFusionWindowDescriptor } from "@shared/contracts/fusion.ts";
import {
  createStandaloneWorkbenchNodeId,
  rendererRouteOwnsAgentOutcomeNotifications,
  resolveFusionKindForWorkbenchTypeId,
  resolveFusionWorkbenchTypeId,
  resolveMostRecentFusionWindow
} from "./fusionWindowModel.ts";

test("Fusion renderer maps native kinds to existing Workbench contribution types", () => {
  assert.equal(
    resolveFusionWorkbenchTypeId({ kind: "terminal" }),
    "workspace-terminal"
  );
  assert.equal(
    resolveFusionWorkbenchTypeId({
      kind: "file-preview",
      launchPayload: { fileKind: "image" }
    }),
    "workspace-image-file"
  );
  assert.equal(
    resolveFusionKindForWorkbenchTypeId("workspace-app-webview"),
    "workspace-app"
  );
});

test("Fusion MRU policy focuses the most recently used window of a kind", () => {
  const recent = resolveMostRecentFusionWindow(
    [
      createWindow({ id: "browser-old", lastFocusedAtUnixMs: 10 }),
      createWindow({ id: "browser-new", lastFocusedAtUnixMs: 20 }),
      {
        ...createWindow({ id: "terminal", lastFocusedAtUnixMs: 30 }),
        kind: "terminal"
      }
    ],
    "browser"
  );
  assert.equal(recent?.windowInstanceId, "browser-new");
});

test("standalone node ids retain contribution identity without conflating native windows", () => {
  assert.equal(
    createStandaloneWorkbenchNodeId({
      instanceId: "terminal-7",
      typeId: "workspace-terminal"
    }),
    "workspace-terminal:terminal-7"
  );
  assert.equal(
    createStandaloneWorkbenchNodeId({
      instanceId: "workspace-files",
      typeId: "workspace-files"
    }),
    "workspace-files"
  );
});

test("only the legacy Workspace container owns Agent outcome notifications", () => {
  assert.equal(rendererRouteOwnsAgentOutcomeNotifications("workspace"), true);
  assert.equal(
    rendererRouteOwnsAgentOutcomeNotifications("fusion-dock"),
    false
  );
  assert.equal(
    rendererRouteOwnsAgentOutcomeNotifications("fusion-tool"),
    false
  );
  assert.equal(rendererRouteOwnsAgentOutcomeNotifications("agent"), false);
});

function createWindow(input: {
  id: string;
  lastFocusedAtUnixMs: number;
}): DesktopFusionWindowDescriptor {
  return {
    createdAtUnixMs: 1,
    focused: false,
    kind: "browser",
    lastFocusedAtUnixMs: input.lastFocusedAtUnixMs,
    resourceId: null,
    title: null,
    visibility: "visible",
    windowInstanceId: input.id,
    workspaceId: "workspace-1"
  };
}
