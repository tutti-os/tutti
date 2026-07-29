import assert from "node:assert/strict";
import test from "node:test";
import type { WorkspaceAppCenterViewState } from "@tutti-os/workspace-app-center";
import { createStandaloneAgentWorkspaceAppSurfacePresenter } from "./standaloneAgentWorkspaceAppSurfacePresenter.ts";

test("standalone agent app presenter selects the app before runtime preparation", () => {
  const calls: string[] = [];
  let viewState: WorkspaceAppCenterViewState = {
    activeAppTab: "recommended",
    openAppId: null
  };
  const presenter = createStandaloneAgentWorkspaceAppSurfacePresenter({
    ensureWorkspaceAppPolling: () => calls.push("poll"),
    getViewState: () => viewState,
    setViewState: ({ state }) => {
      viewState = { ...viewState, ...state };
      calls.push(`select:${viewState.openAppId ?? ""}`);
    },
    workspaceId: "workspace-1"
  });

  presenter.beginOpen({
    appId: "ai-slide",
    attemptId: 1,
    workspaceId: "workspace-1"
  });

  assert.equal(viewState.openAppId, "ai-slide");
  assert.deepEqual(viewState.openAppIds, ["ai-slide"]);
  assert.deepEqual(calls, ["poll", "select:ai-slide"]);
});

test("standalone agent app presenter does not let a stale failure clear a newer selection", () => {
  let viewState: WorkspaceAppCenterViewState = {
    activeAppTab: "recommended",
    openAppId: null
  };
  const presenter = createStandaloneAgentWorkspaceAppSurfacePresenter({
    ensureWorkspaceAppPolling() {},
    getViewState: () => viewState,
    setViewState: ({ state }) => {
      viewState = { ...viewState, ...state };
    },
    workspaceId: "workspace-1"
  });
  const first = {
    appId: "ai-slide",
    attemptId: 1,
    workspaceId: "workspace-1"
  };
  presenter.beginOpen(first);
  presenter.beginOpen({
    appId: "ai-doc",
    attemptId: 2,
    workspaceId: "workspace-1"
  });

  presenter.rollbackOpen(first);

  assert.equal(viewState.openAppId, "ai-doc");
});

test("standalone agent app presenter reports success only for the active selection", () => {
  const harness = createPresenterHarness();
  const first = {
    appId: "ai-slide",
    attemptId: 1,
    workspaceId: "workspace-1"
  };
  const second = {
    appId: "ai-doc",
    attemptId: 2,
    workspaceId: "workspace-1"
  };
  harness.presenter.beginOpen(first);
  harness.presenter.beginOpen(second);

  assert.equal(
    harness.presenter.presentPrepared({
      appId: first.appId,
      attempt: first,
      prepared: true,
      workspaceId: first.workspaceId
    }),
    false
  );
  assert.equal(harness.getViewState().openAppId, second.appId);
  assert.equal(
    harness.presenter.presentPrepared({
      appId: second.appId,
      attempt: second,
      prepared: true,
      workspaceId: second.workspaceId
    }),
    true
  );
});

test("standalone agent app presenter does not report an older launch after the newer launch fails", () => {
  const harness = createPresenterHarness();
  const first = {
    appId: "ai-slide",
    attemptId: 1,
    workspaceId: "workspace-1"
  };
  const second = {
    appId: "ai-doc",
    attemptId: 2,
    workspaceId: "workspace-1"
  };
  harness.presenter.beginOpen(first);
  harness.presenter.beginOpen(second);

  harness.presenter.rollbackOpen(second);

  assert.equal(harness.getViewState().openAppId, "ai-slide");
  assert.deepEqual(harness.getViewState().openAppIds, ["ai-slide"]);
  assert.equal(
    harness.presenter.presentPrepared({
      appId: first.appId,
      attempt: first,
      prepared: true,
      workspaceId: first.workspaceId
    }),
    false
  );
});

test("standalone agent app presenter does not report success after its selection closes", () => {
  const harness = createPresenterHarness();
  const attempt = {
    appId: "ai-slide",
    attemptId: 1,
    workspaceId: "workspace-1"
  };
  harness.presenter.beginOpen(attempt);

  harness.presenter.close({
    appId: attempt.appId,
    workspaceId: attempt.workspaceId
  });

  assert.equal(
    harness.presenter.presentPrepared({
      appId: attempt.appId,
      attempt,
      prepared: true,
      workspaceId: attempt.workspaceId
    }),
    false
  );
});

function createPresenterHarness() {
  let viewState: WorkspaceAppCenterViewState = {
    activeAppTab: "recommended",
    openAppId: null
  };
  return {
    getViewState: () => viewState,
    presenter: createStandaloneAgentWorkspaceAppSurfacePresenter({
      ensureWorkspaceAppPolling() {},
      getViewState: () => viewState,
      setViewState: ({ state }) => {
        viewState = { ...viewState, ...state };
      },
      workspaceId: "workspace-1"
    })
  };
}
