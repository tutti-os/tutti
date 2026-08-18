import assert from "node:assert/strict";
import test from "node:test";
import type {
  DesktopPreferencesStateResponse,
  PutDesktopPreferencesRequest,
  TuttidClient
} from "@tutti-os/client-tuttid-ts";
import { defaultDesktopWorkbenchShortcuts } from "../../shared/preferences/index.ts";
import { createDesktopHostPreferencesState } from "../desktopHostPreferences.ts";
import type { DesktopLogger } from "../logging.ts";
import { createDesktopWorkspaceLaunch } from "./desktopWorkspaceLaunch.ts";
import type {
  WorkspaceLaunchAdapters,
  WorkspaceLaunchWorkspaceWindowOptions
} from "./workspaceLaunch.ts";

const standaloneAgentModeFlag = "workspace.standaloneAgentMode";

test("desktop startup opens the Agent window after fresh profile initialization", async () => {
  const putRequests: PutDesktopPreferencesRequest[] = [];
  const client = createClient({
    async getDesktopPreferences() {
      return createPreferencesState(false, {
        [standaloneAgentModeFlag]: true
      });
    },
    async putDesktopPreferences(request) {
      putRequests.push(request);
      return {
        initialized: true,
        preferences: request.preferences
      };
    }
  });
  const preferences = await createDesktopHostPreferencesState({
    fallbackLocale: "en",
    logger: createLogger(),
    tuttidClient: client
  });
  const opened = await openStartupWindow(preferences, client);

  assert.equal(putRequests.length, 1);
  assert.equal(putRequests[0]?.writeMode, "initializeIfAbsent");
  assert.deepEqual(opened, {
    options: { windowKind: "agent", workspaceUiMode: "agent" },
    workspaceID: "workspace-1"
  });
});

test("desktop startup honors an existing OS preference returned by successful initialization", async () => {
  let getCalls = 0;
  let capturedRequest: PutDesktopPreferencesRequest | undefined;
  const client = createClient({
    async getDesktopPreferences() {
      getCalls++;
      return createPreferencesState(false, {
        [standaloneAgentModeFlag]: true
      });
    },
    async putDesktopPreferences(request) {
      capturedRequest = request;
      return createPreferencesState(true, {
        [standaloneAgentModeFlag]: false
      });
    }
  });
  const preferences = await createDesktopHostPreferencesState({
    fallbackLocale: "en",
    logger: createLogger(),
    tuttidClient: client
  });
  const opened = await openStartupWindow(preferences, client);

  assert.equal(capturedRequest?.writeMode, "initializeIfAbsent");
  assert.equal(
    capturedRequest?.preferences.featureFlags[standaloneAgentModeFlag],
    true
  );
  assert.equal(getCalls, 1);
  assert.deepEqual(opened, {
    options: { windowKind: "workspace", workspaceUiMode: "os" },
    workspaceID: "workspace-1"
  });
});

test("desktop startup carries the fresh Agent fallback when initialization and reconciliation do not commit", async () => {
  let getCalls = 0;
  const client = createClient({
    async getDesktopPreferences() {
      getCalls += 1;
      return createPreferencesState(false, {
        [standaloneAgentModeFlag]: true
      });
    },
    async putDesktopPreferences() {
      throw new Error("preferences write unavailable");
    }
  });
  const preferences = await createDesktopHostPreferencesState({
    fallbackLocale: "en",
    logger: createLogger(),
    tuttidClient: client
  });

  const opened = await openStartupWindow(preferences, client);

  assert.equal(getCalls, 2);
  assert.deepEqual(opened, {
    options: { windowKind: "agent", workspaceUiMode: "agent" },
    workspaceID: "workspace-1"
  });
});

test("desktop startup maps persisted and unavailable preference states to the expected window kind", async (t) => {
  const cases: Array<{
    getDesktopPreferences: () => Promise<DesktopPreferencesStateResponse>;
    name: string;
    want: "agent" | "workspace";
  }> = [
    {
      name: "explicit Agent",
      async getDesktopPreferences() {
        return createPreferencesState(true, {
          [standaloneAgentModeFlag]: true
        });
      },
      want: "agent"
    },
    {
      name: "explicit OS",
      async getDesktopPreferences() {
        return createPreferencesState(true, {
          [standaloneAgentModeFlag]: false
        });
      },
      want: "workspace"
    },
    {
      name: "legacy missing key",
      async getDesktopPreferences() {
        return createPreferencesState(true, {});
      },
      want: "workspace"
    },
    {
      name: "initial read error",
      async getDesktopPreferences() {
        throw new Error("preferences unavailable");
      },
      want: "workspace"
    }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      let putCalls = 0;
      const client = createClient({
        getDesktopPreferences: testCase.getDesktopPreferences,
        async putDesktopPreferences() {
          putCalls++;
          throw new Error("putDesktopPreferences should not be called");
        }
      });
      const preferences = await createDesktopHostPreferencesState({
        fallbackLocale: "en",
        logger: createLogger(),
        tuttidClient: client
      });
      const opened = await openStartupWindow(preferences, client);

      assert.equal(opened.options.windowKind, testCase.want);
      assert.equal(
        opened.options.workspaceUiMode,
        testCase.want === "agent" ? "agent" : "os"
      );
      assert.equal(putCalls, 0);
    });
  }
});

type TestClient = Pick<
  TuttidClient,
  | "getDesktopPreferences"
  | "getStartupWorkspace"
  | "putDesktopPreferences"
  | "trackEvents"
>;

function createClient(
  overrides: Pick<TestClient, "getDesktopPreferences" | "putDesktopPreferences">
): TestClient {
  return {
    ...overrides,
    async getStartupWorkspace() {
      return {
        id: "workspace-1",
        lastOpenedAt: "2026-08-17T00:00:00Z",
        name: "Workspace 1"
      };
    },
    async trackEvents() {}
  };
}

async function openStartupWindow(
  preferences: Awaited<ReturnType<typeof createDesktopHostPreferencesState>>,
  client: TestClient
): Promise<{
  options: WorkspaceLaunchWorkspaceWindowOptions;
  workspaceID: string;
}> {
  let opened:
    | {
        options: WorkspaceLaunchWorkspaceWindowOptions;
        workspaceID: string;
      }
    | undefined;
  const adapters: WorkspaceLaunchAdapters = {
    async ensureAgentBrowserHost() {},
    async showAgentWindow() {},
    async showWorkspaceWindow(workspaceID, options) {
      opened = { options, workspaceID };
    },
    warnStartupWindowResolutionFailure() {}
  };
  const launch = createDesktopWorkspaceLaunch({
    adapters,
    logger: createLogger(),
    preferences,
    tuttidClient: client
  });

  await launch.openStartupWindow();
  assert.ok(opened);
  return opened;
}

function createPreferencesState(
  initialized: boolean,
  featureFlags: Record<string, boolean>
): DesktopPreferencesStateResponse {
  return {
    initialized,
    preferences: {
      agentCliUpdateCheckEnabled: true,
      agentComposerDefaultsByProvider: {},
      agentGuiConversationRailCollapsedByProvider: {},
      agentConversationDetailMode: "coding",
      agentDockLayout: "unified",
      appCatalogChannel: "production",
      browserUseConnectionMode: "isolated",
      defaultAgentProvider: "tutti-agent",
      deletedAgentConversationRetentionDays: 30,
      dockIconStyle: "default",
      dockPlacement: "bottom",
      featureFlags,
      fileDefaultOpenersByExtension: {},
      locale: "en",
      minimizeAnimation: "genie",
      showAppDeveloperSources: false,
      sleepPreventionMode: "never",
      themeSource: "dark",
      updateChannel: "stable",
      updatePolicy: "prompt",
      workbenchShortcuts: defaultDesktopWorkbenchShortcuts
    }
  };
}

function createLogger(): DesktopLogger {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
    async close() {}
  };
}
