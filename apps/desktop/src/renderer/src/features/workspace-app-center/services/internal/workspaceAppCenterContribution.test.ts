import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { WorkbenchHostLaunchRequest } from "@tutti-os/workbench-surface";
import type { ReporterEventInput } from "../../../analytics/services/reporterService.interface.ts";
import type { IWorkspaceAppCenterService } from "../workspaceAppCenterService.interface.ts";
import type {
  WorkspaceAppCenterApp,
  WorkspaceAppCenterReadableStoreState
} from "@tutti-os/workspace-app-center";
import { createWorkspaceAppWebviewBrowserLease } from "./workspaceAppWebviewBrowserAnalytics.ts";
import {
  shouldPreserveWorkspaceAppWebviewDuringHandoff,
  shouldRenderWorkspaceAppBrowserNode,
  shouldSyncWorkspaceAppWebviewDefaultUrl
} from "./workspaceAppCenterWebviewHandoff.ts";
import { resolveWorkspaceAppWebviewUrl } from "./workspaceAppCenterWebviewUrl.ts";
import {
  readWorkspaceAppIdFromNodeId,
  reportWorkspaceAppOpenedFromDockEntry,
  resolveWorkspaceAppCenterLaunchRequest,
  workspaceAppDockEntryId,
  workspaceAppWebviewInstanceId,
  workspaceAppWebviewTypeID
} from "./workspaceAppCenterLaunchRequest.ts";

const contributionSource = readFileSync(
  new URL("./workspaceAppCenterContribution.tsx", import.meta.url),
  "utf8"
);

test("workspace app center windows render unified traffic lights in custom headers", () => {
  assert.match(
    contributionSource,
    /renderHeader: \(context\) => \(\s*<WorkspaceAppCenterWorkbenchHeader context=\{context\} i18n=\{input\.i18n\} \/>/
  );
  assert.match(
    contributionSource,
    /<WorkspaceWorkbenchTrafficLights[\s\S]*displayMode=\{context\.displayMode\}[\s\S]*windowActions=\{context\.windowActions\}/
  );
  assert.doesNotMatch(contributionSource, /\{context\.defaultActions\}/);
});

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

test("workspace app launch request restarts pending app from dock", async () => {
  const app = createApp({
    appId: "ready",
    runtimeStatus: "installed_pending_restart",
    launchUrl: "http://127.0.0.1:3000"
  });
  const restartCalls: Array<{ appId: string; workspaceId: string }> = [];
  const result = await resolveWorkspaceAppCenterLaunchRequest({
    appCenterService: createAppCenterService([app], {
      restartAndOpenApp: async (input) => {
        restartCalls.push(input);
        return true;
      }
    }),
    request: {
      ...createLaunchRequestContext(),
      dockEntryId: workspaceAppDockEntryId("ready"),
      reason: "dock",
      typeId: workspaceAppWebviewTypeID,
      workspaceId: "workspace-1"
    }
  });

  assert.equal(result, null);
  assert.deepEqual(restartCalls, [
    {
      appId: "ready",
      workspaceId: "workspace-1"
    }
  ]);
});

test("workspace app launch request preserves open-route intent across pending restart", async () => {
  const app = createApp({
    appId: "docs",
    runtimeStatus: "installed_pending_restart",
    launchUrl: "http://127.0.0.1:3000"
  });
  const restartCalls: Array<
    Parameters<IWorkspaceAppCenterService["restartAndOpenApp"]>[0]
  > = [];
  const result = await resolveWorkspaceAppCenterLaunchRequest({
    appCenterService: createAppCenterService([app], {
      restartAndOpenApp: async (input) => {
        restartCalls.push(input);
        return true;
      }
    }),
    request: {
      ...createLaunchRequestContext(),
      payload: {
        appId: "docs",
        intent: {
          kind: "open-route",
          params: { mode: "preview" },
          route: "/files",
          state: { selectedPath: "/tmp/a.md" }
        }
      },
      reason: "host",
      typeId: workspaceAppWebviewTypeID,
      workspaceId: "workspace-1"
    }
  });

  assert.equal(result, null);
  assert.deepEqual(restartCalls, [
    {
      appId: "docs",
      intent: {
        kind: "open-route",
        params: { mode: "preview" },
        route: "/files",
        state: { selectedPath: "/tmp/a.md" }
      },
      workspaceId: "workspace-1"
    }
  ]);
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

test("workspace app webview URL preserves external runtime URL during update handoff", () => {
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
      },
      preferExternalState: true
    }),
    "http://127.0.0.1:4173/rooms/old"
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

test("workspace app webview URL supports open-route activation payloads", () => {
  assert.equal(
    resolveWorkspaceAppWebviewUrl({
      activation: {
        payload: {
          appId: "docs",
          intent: {
            kind: "open-route",
            params: { mode: "preview" },
            route: "/files"
          },
          url: "http://127.0.0.1:51234/files?mode=preview"
        },
        sequence: 1,
        type: "workspace-app:open"
      },
      appCanUseExternalState: true,
      appLaunchUrl: "http://127.0.0.1:51234/",
      externalNodeState: null
    }),
    "http://127.0.0.1:51234/files?mode=preview"
  );
});

test("workspace app open-route resolves from the app origin root", async () => {
  const app = createApp({
    appId: "docs",
    runtimeStatus: "running",
    launchUrl: "http://127.0.0.1:51234/app-shell/"
  });

  const result = await resolveWorkspaceAppCenterLaunchRequest({
    appCenterService: createAppCenterService([app]),
    request: {
      ...createLaunchRequestContext(),
      payload: {
        appId: "docs",
        intent: {
          kind: "open-route",
          params: { mode: "preview" },
          route: "/files"
        }
      },
      reason: "host",
      typeId: workspaceAppWebviewTypeID,
      workspaceId: "workspace-1"
    }
  });

  assert.equal(result?.activation?.type, "workspace-app:open");
  assert.deepEqual(result?.activation?.payload, {
    appId: "docs",
    intent: {
      kind: "open-route",
      params: { mode: "preview" },
      route: "/files"
    },
    title: "Ready",
    url: "http://127.0.0.1:51234/files?mode=preview"
  });
});

test("workspace app open-route rejects protocol-relative routes", async () => {
  const app = createApp({
    appId: "docs",
    runtimeStatus: "running",
    launchUrl: "http://127.0.0.1:51234/app-shell/"
  });

  const result = await resolveWorkspaceAppCenterLaunchRequest({
    appCenterService: createAppCenterService([app]),
    request: {
      ...createLaunchRequestContext(),
      payload: {
        appId: "docs",
        intent: {
          kind: "open-route",
          route: "//example.com/files"
        }
      },
      reason: "host",
      typeId: workspaceAppWebviewTypeID,
      workspaceId: "workspace-1"
    }
  });

  assert.equal(result?.activation?.type, "open-url");
  assert.deepEqual(result?.activation?.payload, {
    appId: "docs",
    title: "Ready",
    url: "http://127.0.0.1:51234/app-shell/"
  });
});

test("workspace app webview stays mounted during running app update handoff", () => {
  const installingApp = createApp({
    installed: true,
    launchUrl: "http://127.0.0.1:51234/",
    runtimeStatus: "installing"
  });

  assert.equal(
    shouldPreserveWorkspaceAppWebviewDuringHandoff(installingApp),
    true
  );
  assert.equal(
    shouldRenderWorkspaceAppBrowserNode(
      installingApp,
      "http://127.0.0.1:51234/"
    ),
    true
  );
});

test("workspace app webview shows update handoff while progress is published for a running app", () => {
  const downloadingApp = createApp({
    installed: true,
    installProgress: {
      downloadedBytes: null,
      indeterminate: false,
      overallPercent: 0,
      totalBytes: null,
      userPhase: "downloading"
    },
    launchUrl: "http://127.0.0.1:51234/",
    runtimeStatus: "running"
  });

  assert.equal(
    shouldPreserveWorkspaceAppWebviewDuringHandoff(downloadingApp),
    true
  );
  assert.equal(
    shouldRenderWorkspaceAppBrowserNode(
      downloadingApp,
      "http://127.0.0.1:51234/"
    ),
    true
  );
  assert.equal(shouldSyncWorkspaceAppWebviewDefaultUrl(downloadingApp), false);
});

test("workspace app webview handoff does not mount without a usable URL", () => {
  const installingApp = createApp({
    installed: true,
    launchUrl: null,
    runtimeStatus: "installing"
  });

  assert.equal(
    shouldRenderWorkspaceAppBrowserNode(installingApp, "about:blank"),
    false
  );
});

test("workspace app webview stays mounted while installed package is waiting for restart", () => {
  const pendingRestartApp = createApp({
    installed: true,
    installProgress: null,
    launchUrl: "http://127.0.0.1:51234/",
    runtimeStatus: "installed_pending_restart"
  });

  assert.equal(
    shouldPreserveWorkspaceAppWebviewDuringHandoff(pendingRestartApp),
    true
  );
  assert.equal(
    shouldRenderWorkspaceAppBrowserNode(
      pendingRestartApp,
      "http://127.0.0.1:51234/"
    ),
    true
  );
  assert.equal(
    shouldSyncWorkspaceAppWebviewDefaultUrl(pendingRestartApp),
    false
  );
});

test("workspace app webview bridges transient stopping during update handoff", () => {
  const stoppingApp = createApp({
    installed: true,
    installProgress: null,
    launchUrl: null,
    runtimeStatus: "stopping"
  });

  assert.equal(
    shouldPreserveWorkspaceAppWebviewDuringHandoff(stoppingApp, {
      externalNodeUrl: "http://127.0.0.1:58028/",
      hadRecentHandoff: true
    }),
    true
  );
  assert.equal(
    shouldRenderWorkspaceAppBrowserNode(
      stoppingApp,
      "http://127.0.0.1:58028/",
      {
        externalNodeUrl: "http://127.0.0.1:58028/",
        hadRecentHandoff: true
      }
    ),
    true
  );
  assert.equal(
    shouldSyncWorkspaceAppWebviewDefaultUrl(stoppingApp, {
      externalNodeUrl: "http://127.0.0.1:58028/",
      hadRecentHandoff: true
    }),
    false
  );
});

test("workspace app webview does not preserve idle app without recent handoff", () => {
  const idleApp = createApp({
    installed: true,
    installProgress: null,
    launchUrl: null,
    runtimeStatus: "idle"
  });

  assert.equal(
    shouldPreserveWorkspaceAppWebviewDuringHandoff(idleApp, {
      externalNodeUrl: "http://127.0.0.1:58028/",
      hadRecentHandoff: false
    }),
    false
  );
  assert.equal(
    shouldRenderWorkspaceAppBrowserNode(idleApp, "http://127.0.0.1:58028/", {
      externalNodeUrl: "http://127.0.0.1:58028/",
      hadRecentHandoff: false
    }),
    false
  );
});

test("workspace app webview does not bridge terminal idle or failed handoff states", () => {
  for (const runtimeStatus of ["idle", "failed"] as const) {
    const app = createApp({
      installed: true,
      installProgress: null,
      launchUrl: null,
      runtimeStatus
    });
    const handoffOptions = {
      externalNodeUrl: "http://127.0.0.1:58028/",
      hadRecentHandoff: true
    };

    assert.equal(
      shouldPreserveWorkspaceAppWebviewDuringHandoff(app, handoffOptions),
      false
    );
    assert.equal(
      shouldRenderWorkspaceAppBrowserNode(
        app,
        "http://127.0.0.1:58028/",
        handoffOptions
      ),
      false
    );
  }
});

test("workspace app webview resumes default URL sync outside update handoff", () => {
  const runningApp = createApp({
    installed: true,
    installProgress: null,
    launchUrl: "http://127.0.0.1:51234/",
    runtimeStatus: "running"
  });

  assert.equal(shouldSyncWorkspaceAppWebviewDefaultUrl(runningApp), true);
});

test("workspace app webview keeps handoff cover while syncing to the restarted runtime URL", () => {
  const runningApp = createApp({
    installed: true,
    installProgress: null,
    launchUrl: "http://127.0.0.1:59636",
    runtimeStatus: "running"
  });
  const handoffOptions = {
    externalNodeUrl: "http://127.0.0.1:59586/",
    hadRecentHandoff: true
  };

  assert.equal(
    shouldPreserveWorkspaceAppWebviewDuringHandoff(runningApp, handoffOptions),
    true
  );
  assert.equal(
    shouldRenderWorkspaceAppBrowserNode(
      runningApp,
      "http://127.0.0.1:59636",
      handoffOptions
    ),
    true
  );
  assert.equal(
    shouldSyncWorkspaceAppWebviewDefaultUrl(runningApp, handoffOptions),
    true
  );
  assert.equal(
    resolveWorkspaceAppWebviewUrl({
      activation: null,
      appCanUseExternalState: true,
      appLaunchUrl: runningApp.launchUrl ?? null,
      externalNodeState: {
        title: "Group Chat",
        url: handoffOptions.externalNodeUrl
      },
      preferExternalState:
        shouldPreserveWorkspaceAppWebviewDuringHandoff(
          runningApp,
          handoffOptions
        ) &&
        !shouldSyncWorkspaceAppWebviewDefaultUrl(runningApp, handoffOptions)
    }),
    "http://127.0.0.1:59636"
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
