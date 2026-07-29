import assert from "node:assert/strict";
import test from "node:test";
import type { WorkspaceAppCenterViewState } from "@tutti-os/workspace-app-center";
import {
  closeWorkspaceAppTab,
  openWorkspaceAppTab,
  selectWorkspaceAppTab
} from "../workspaceAppCenterTabs.ts";

const catalogState: WorkspaceAppCenterViewState = {
  activeAppTab: "recommended",
  openAppId: null,
  openAppIds: []
};

test("opening apps appends new tabs and selects an existing tab", () => {
  const first = openWorkspaceAppTab(catalogState, "ai-slide");
  const second = openWorkspaceAppTab(first, "ai-doc");
  const reopened = openWorkspaceAppTab(second, "ai-slide");

  assert.deepEqual(first, {
    ...catalogState,
    openAppId: "ai-slide",
    openAppIds: ["ai-slide"]
  });
  assert.deepEqual(second.openAppIds, ["ai-slide", "ai-doc"]);
  assert.equal(second.openAppId, "ai-doc");
  assert.deepEqual(reopened.openAppIds, ["ai-slide", "ai-doc"]);
  assert.equal(reopened.openAppId, "ai-slide");
});

test("closing tabs preserves inactive selection and selects an adjacent fallback", () => {
  const state: WorkspaceAppCenterViewState = {
    activeAppTab: "recommended",
    openAppId: "ai-doc",
    openAppIds: ["ai-slide", "ai-doc", "ai-sheet"]
  };

  assert.deepEqual(closeWorkspaceAppTab(state, "ai-slide"), {
    ...state,
    openAppIds: ["ai-doc", "ai-sheet"]
  });
  assert.deepEqual(closeWorkspaceAppTab(state, "ai-doc"), {
    ...state,
    openAppId: "ai-sheet",
    openAppIds: ["ai-slide", "ai-sheet"]
  });
  assert.deepEqual(
    closeWorkspaceAppTab({ ...state, openAppId: "ai-sheet" }, "ai-sheet"),
    {
      ...state,
      openAppId: "ai-doc",
      openAppIds: ["ai-slide", "ai-doc"]
    }
  );
});

test("the catalog selection keeps app tabs open", () => {
  const state = openWorkspaceAppTab(catalogState, "ai-doc");

  assert.deepEqual(selectWorkspaceAppTab(state, null), {
    ...state,
    openAppId: null
  });
});
