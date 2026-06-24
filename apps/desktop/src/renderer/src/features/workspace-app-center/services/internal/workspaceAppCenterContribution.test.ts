import assert from "node:assert/strict";
import test from "node:test";
import type { WorkbenchHostLaunchRequest } from "@tutti-os/workbench-surface";
import type { ReporterEventInput } from "../../../analytics/services/reporterService.interface.ts";
import type { IWorkspaceAppCenterService } from "../workspaceAppCenterService.interface.ts";
import type {
  WorkspaceAppCenterApp,
  WorkspaceAppCenterReadableStoreState
} from "@tutti-os/workspace-app-center";
import { createWorkspaceAppWebviewBrowserLease } from "./workspaceAppWebviewBrowserAnalytics.ts";
import { resolveWorkspaceAppWebviewUrl } from "./workspaceAppCenterWebviewUrl.ts";
import {
  readWorkspaceAppIdFromNodeId,
  reportWorkspaceAppOpenedFromDockEntry,
  resolveWorkspaceAppCenterLaunchRequest,
  workspaceAppDockEntryId,
  workspaceAppWebviewInstanceId,
  workspaceAppWebviewTypeID
} from "./workspaceAppCenterLaunchRequest.ts";

test("workspace app node ids resolve app ids from dock and webview node formats", () => {
  assert.equal(
    readWorkspaceAppIdFromNodeId(workspaceAppDockEntryId("group-chat")),
    "group-chat"
  );
  assert.equal(
    readWorkspaceAppIdFromNodeId(
      `${workspaceAppWebviewTypeID}:${workspaceAppWebviewInstanceId("group-chat")}`
    ),
    "group-chat"
  );
  assert.equal(readWorkspaceAppIdFromNodeId("browser:browser-1"), null);
});

test("workspace app contribution reports app open from dock launch requests", async () => {
  const reporterCalls: ReporterEventInput[][] = [];
  const app = createApp({
    appId: "ready",
    runtimeStatus: "running",
    launchUrl: "http://127.0.0.1:3000"
  });
  const result = await resolveWorkspaceAppCenterLaunchRequest({
    appCenterService: createAppCenterService([app]),
    reporterService: createReporterService(reporterCalls),
    request: {
      ...createLaunchRequestContext(),
      dockEntryId: workspaceAppDockEntryId("ready"),
      reason: "dock",
      typeId: workspaceAppWebviewTypeID,
      workspaceId: "workspace-1"
    }
  });

  assert.equal(result?.typeId, workspaceAppWebviewTypeID);
  assert.equal(result?.dockEntryId, workspaceAppDockEntryId("ready"));
  assert.equal(reporterCalls.length, 1);
  assert.deepEqual(
    reporterCalls[0]?.map(({ clientTS: _clientTS, ...event }) => event),
    [
      {
        name: "app_center.app_opened",
        params: {
          app_id: "ready",
          app_source: "builtin",
          prev_status: "running"
        }
      }
    ]
  );
});

test("workspace app launch request does not apply app-specific minimum webview size", async () => {
  const app = createApp({
    appId: "ready",
    runtimeStatus: "running",
    launchUrl: "http://127.0.0.1:3000"
  });
  const result = await resolveWorkspaceAppCenterLaunchRequest({
    appCenterService: createAppCenterService([app]),
    request: {
      ...createLaunchRequestContext(),
      dockEntryId: workspaceAppDockEntryId("ready"),
      reason: "dock",
      typeId: workspaceAppWebviewTypeID,
      workspaceId: "workspace-1"
    }
  });

  assert.equal(result?.sizeConstraints, undefined);
  assert.deepEqual(result?.defaultFrame, {
    height: 680,
    width: 1040,
    x: 170,
    y: 64
  });
});

test("workspace app launch request preserves prepared payload previous status", async () => {
  const reporterCalls: ReporterEventInput[][] = [];
  const app = createApp({
    appId: "ready",
    runtimeStatus: "running",
    launchUrl: "http://127.0.0.1:3000"
  });

  const result = await resolveWorkspaceAppCenterLaunchRequest({
    appCenterService: createAppCenterService([app]),
    reporterService: createReporterService(reporterCalls),
    request: {
      ...createLaunchRequestContext(),
      payload: {
        appId: "ready",
        prepared: true,
        prevStatus: "idle"
      },
      reason: "host",
      typeId: workspaceAppWebviewTypeID,
      workspaceId: "workspace-1"
    }
  });

  assert.equal(result?.typeId, workspaceAppWebviewTypeID);
  assert.deepEqual(
    reporterCalls[0]?.map(({ clientTS: _clientTS, ...event }) => event),
    [
      {
        name: "app_center.app_opened",
        params: {
          app_id: "ready",
          app_source: "builtin",
          prev_status: "idle"
        }
      }
    ]
  );
});

test("workspace app webview URL prefers the current launch URL over stale activation ports", () => {
  assert.equal(
    resolveWorkspaceAppWebviewUrl({
      activation: {
        payload: {
          appId: "group-chat",
          url: "http://127.0.0.1:4173/rooms/old"
        },
        sequence: 1,
        type: "open-url"
      },
      appCanUseExternalState: true,
      appLaunchUrl: "http://127.0.0.1:51234/",
      externalNodeState: {
        title: "Group Chat",
        url: "http://127.0.0.1:4173/rooms/old"
      }
    }),
    "http://127.0.0.1:51234/"
  );
});

test("workspace app webview URL preserves same-origin activation deep links", () => {
  assert.equal(
    resolveWorkspaceAppWebviewUrl({
      activation: {
        payload: {
          appId: "group-chat",
          url: "http://127.0.0.1:51234/rooms/current"
        },
        sequence: 1,
        type: "open-url"
      },
      appCanUseExternalState: true,
      appLaunchUrl: "http://127.0.0.1:51234/",
      externalNodeState: null
    }),
    "http://127.0.0.1:51234/rooms/current"
  );
});

test("workspace app dock entry focus reports app open from the dock entry id", () => {
  const reporterCalls: ReporterEventInput[][] = [];
  const app = createApp({
    appId: "ready",
    runtimeStatus: "running",
    launchUrl: "http://127.0.0.1:3000"
  });

  reportWorkspaceAppOpenedFromDockEntry({
    appCenterService: createAppCenterService([app]),
    entryId: workspaceAppDockEntryId("ready"),
    reporterService: createReporterService(reporterCalls)
  });

  assert.equal(reporterCalls.length, 1);
  assert.deepEqual(
    reporterCalls[0]?.map(({ clientTS: _clientTS, ...event }) => event),
    [
      {
        name: "app_center.app_opened",
        params: {
          app_id: "ready",
          app_source: "builtin",
          prev_status: "running"
        }
      }
    ]
  );
});

test("workspace app webview browser lease does not report browser lifecycle events", () => {
  const reporterCalls: ReporterEventInput[][] = [];
  let now = 1749124800000;
  const lease = createWorkspaceAppWebviewBrowserLease({
    reporterNow: () => now,
    reporterService: createReporterService(reporterCalls)
  });

  now = 1749124800250;
  lease?.release();

  assert.deepEqual(reporterCalls, []);
});

function createApp(
  overrides: Partial<WorkspaceAppCenterApp> = {}
): WorkspaceAppCenterApp {
  return {
    appId: "ready",
    createdAtUnixMs: 0,
    description: "",
    enabled: true,
    exportable: false,
    installed: true,
    localizations: [],
    minimizeBehavior: "keep-mounted",
    name: "Ready",
    references: { listSupported: false },
    runtimeStatus: "idle",
    source: "builtin",
    stateRevision: 1,
    tags: [],
    launchUrl: null,
    version: "1.0.0",
    ...overrides
  };
}

function createAppCenterService(
  apps: readonly WorkspaceAppCenterApp[],
  overrides: Partial<IWorkspaceAppCenterService> = {}
): IWorkspaceAppCenterService {
  return {
    _serviceBrand: undefined,
    store: {
      apps
    } as WorkspaceAppCenterReadableStoreState,
    prepareAppLaunch: async ({ appId }: { appId: string }) =>
      apps.find((app) => app.appId === appId) ?? null,
    getViewState: () => ({ activeAppTab: "apps" }),
    subscribe: () => () => {},
    ...overrides
  } as unknown as IWorkspaceAppCenterService;
}

function createLaunchRequestContext(): Pick<
  WorkbenchHostLaunchRequest,
  "layoutConstraints" | "surfaceSize"
> {
  return {
    layoutConstraints: {
      minHeight: 160,
      minWidth: 280,
      safeArea: {
        bottom: 79,
        left: 0,
        right: 0,
        top: 52
      },
      surfacePadding: 0
    },
    surfaceSize: {
      height: 900,
      width: 1440
    }
  };
}

function createReporterService(calls: ReporterEventInput[][]) {
  return {
    async trackEvents(events: ReporterEventInput[]) {
      calls.push(events);
    }
  };
}
