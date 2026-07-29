import assert from "node:assert/strict";
import test from "node:test";
import type { WorkspaceAppCenterViewState } from "@tutti-os/workspace-app-center";
import type {
  WorkbenchHostHandle,
  WorkbenchState
} from "@tutti-os/workbench-surface";
import { workspaceAppCenterNodeID } from "../../workspace-app-center/services/workspaceAppCenterLaunchIds.ts";
import { createWorkbenchWorkspaceAppSurfacePresenter } from "./workbenchWorkspaceAppSurfacePresenter.ts";

test("workbench app presenter opens apps as tabs in the singleton app-center node", async () => {
  const launches: unknown[] = [];
  const harness = createViewStateHarness();
  const presenter = createWorkbenchWorkspaceAppSurfacePresenter({
    ...harness,
    host: createHost({ launches }),
    workspaceId: "workspace-1"
  });
  const attempt = {
    appId: "ai-slide",
    attemptId: 1,
    workspaceId: "workspace-1"
  };

  presenter.beginOpen(attempt);
  const opened = await presenter.presentPrepared({
    appId: "ai-slide",
    attempt,
    prepared: true,
    prevStatus: "idle",
    workspaceId: "workspace-1"
  });

  assert.equal(opened, true);
  assert.deepEqual(harness.read(), {
    activeAppTab: "recommended",
    openAppId: "ai-slide",
    openAppIds: ["ai-slide"]
  });
  assert.deepEqual(launches, [
    {
      reason: "host",
      typeId: workspaceAppCenterNodeID
    }
  ]);
});

test("workbench app presenter selects an existing tab and forwards route intent", async () => {
  const activations: unknown[] = [];
  const launches: unknown[] = [];
  const harness = createViewStateHarness({
    activeAppTab: "recommended",
    openAppId: null,
    openAppIds: ["tutti-onboarding"]
  });
  const presenter = createWorkbenchWorkspaceAppSurfacePresenter({
    ...harness,
    host: createHost({ activations, launches }),
    workspaceId: "workspace-1"
  });
  const attempt = {
    appId: "tutti-onboarding",
    attemptId: 2,
    workspaceId: "workspace-1"
  };
  const intent = {
    kind: "open-route" as const,
    params: { step: "welcome" },
    route: "/start"
  };

  presenter.beginOpen(attempt);
  await presenter.presentPrepared({
    appId: "tutti-onboarding",
    attempt,
    intent,
    prepared: true,
    prevStatus: "running",
    workspaceId: "workspace-1"
  });

  assert.deepEqual(harness.read().openAppIds, ["tutti-onboarding"]);
  assert.equal(harness.read().openAppId, "tutti-onboarding");
  assert.deepEqual(activations, [
    [
      { nodeId: "app-center-node" },
      {
        payload: { appId: "tutti-onboarding", intent },
        type: "workspace-app:open"
      }
    ]
  ]);
  assert.deepEqual(launches, [
    {
      launchSource: "onboarding-auto",
      reason: "host",
      typeId: workspaceAppCenterNodeID
    }
  ]);
});

test("workbench app presenter closes tabs and detects inactive open apps", () => {
  const harness = createViewStateHarness({
    activeAppTab: "recommended",
    openAppId: "ai-doc",
    openAppIds: ["ai-slide", "ai-doc"]
  });
  const presenter = createWorkbenchWorkspaceAppSurfacePresenter({
    ...harness,
    host: createHost({}),
    workspaceId: "workspace-1"
  });

  assert.equal(
    presenter.isOpen({ appId: "ai-slide", workspaceId: "workspace-1" }),
    true
  );
  presenter.close({ appId: "ai-slide", workspaceId: "workspace-1" });
  assert.deepEqual(harness.read().openAppIds, ["ai-doc"]);
  assert.equal(harness.read().openAppId, "ai-doc");
});

test("workbench app presenter restores tabs when preparation rolls back", () => {
  const initial = {
    activeAppTab: "community" as const,
    openAppId: "ai-doc",
    openAppIds: ["ai-doc"]
  };
  const harness = createViewStateHarness(initial);
  const presenter = createWorkbenchWorkspaceAppSurfacePresenter({
    ...harness,
    host: createHost({}),
    workspaceId: "workspace-1"
  });
  const attempt = {
    appId: "ai-slide",
    attemptId: 3,
    workspaceId: "workspace-1"
  };

  presenter.beginOpen(attempt);
  presenter.rollbackOpen(attempt);

  assert.deepEqual(harness.read(), initial);
});

test("workbench app presenter keeps a newer tab when an older launch rolls back", () => {
  const harness = createViewStateHarness();
  const presenter = createWorkbenchWorkspaceAppSurfacePresenter({
    ...harness,
    host: createHost({}),
    workspaceId: "workspace-1"
  });
  const first = {
    appId: "ai-slide",
    attemptId: 4,
    workspaceId: "workspace-1"
  };
  const second = {
    appId: "ai-doc",
    attemptId: 5,
    workspaceId: "workspace-1"
  };

  presenter.beginOpen(first);
  presenter.beginOpen(second);
  presenter.rollbackOpen(first);

  assert.deepEqual(harness.read(), {
    activeAppTab: "recommended",
    openAppId: "ai-doc",
    openAppIds: ["ai-doc"]
  });
});

function createViewStateHarness(
  initial: WorkspaceAppCenterViewState = {
    activeAppTab: "recommended",
    openAppId: null,
    openAppIds: []
  }
): {
  getViewState(workspaceId: string): WorkspaceAppCenterViewState;
  read(): WorkspaceAppCenterViewState;
  setViewState(input: {
    state: Partial<WorkspaceAppCenterViewState>;
    workspaceId: string;
  }): void;
} {
  let state = initial;
  return {
    getViewState: () => state,
    read: () => state,
    setViewState: (input) => {
      state = { ...state, ...input.state };
    }
  };
}

function createHost(input: {
  activations?: unknown[];
  launches?: unknown[];
}): WorkbenchHostHandle {
  return {
    activateNode: (...args: unknown[]) => input.activations?.push(args),
    getSnapshot: () => ({ nodes: [] }) as unknown as WorkbenchState,
    launchNode: async (
      request: Parameters<WorkbenchHostHandle["launchNode"]>[0]
    ) => {
      input.launches?.push(request);
      return "app-center-node";
    }
  } as unknown as WorkbenchHostHandle;
}
