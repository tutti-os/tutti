import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  DesktopPreferencesStateResponse,
  PutDesktopPreferencesRequest
} from "@tutti-os/client-tuttid-ts";
import { DesktopPreferencesService } from "../renderer/src/features/desktop-preferences/services/internal/desktopPreferencesService.ts";
import type { DesktopPreferencesClient } from "../renderer/src/features/desktop-preferences/services/internal/adapters/desktopPreferencesClient.ts";
import { defaultDesktopWorkbenchShortcuts } from "../shared/preferences/index.ts";
import { createDesktopHostPreferencesState } from "./desktopHostPreferences.ts";
import type { DesktopLogger } from "./logging.ts";

type Preferences = PutDesktopPreferencesRequest["preferences"];
type SessionLaunchModePatch = Parameters<
  DesktopPreferencesClient["patchAgentSessionLaunchMode"]
>[0];

const standaloneAgentModeFlag = "workspace.standaloneAgentMode";
const installedVersion = "0.2.2-rc.1";

test("failed fresh-profile startup initializes before a session patch and preserves the complete profile across restart", async (t) => {
  const migrationStateRootDir = await mkdtemp(
    join(tmpdir(), "tutti-preferences-vertical-")
  );
  t.after(async () => {
    await rm(migrationStateRootDir, { force: true, recursive: true });
  });
  const installedVersionStatePath = join(
    migrationStateRootDir,
    "migrations",
    "desktop-update-channel-installed-version-v1"
  );
  let storedPreferences: Preferences | null = null;
  let initializationAttempts = 0;
  let replaceAttempts = 0;
  let sessionPatchAttempts = 0;
  const api = {
    async getDesktopPreferences(): Promise<DesktopPreferencesStateResponse> {
      return storedPreferences
        ? { initialized: true, preferences: storedPreferences }
        : { initialized: false, preferences: createDaemonDefaults() };
    },
    async patchAgentSessionLaunchMode(
      input: SessionLaunchModePatch
    ): Promise<void> {
      sessionPatchAttempts++;
      const current = storedPreferences;
      assert.ok(
        current,
        "session launch mode patch must follow durable profile initialization"
      );
      const workspaceModes =
        current.agentSessionLaunchModesByWorkspace?.[input.workspaceId] ?? {};
      storedPreferences = {
        ...current,
        agentSessionLaunchModesByWorkspace: {
          ...current.agentSessionLaunchModesByWorkspace,
          [input.workspaceId]: {
            ...workspaceModes,
            [input.projectSectionKey]: input.mode
          }
        }
      };
    },
    async putDesktopPreferences(
      request: PutDesktopPreferencesRequest
    ): Promise<DesktopPreferencesStateResponse> {
      if (request.writeMode === "initializeIfAbsent") {
        initializationAttempts++;
        if (initializationAttempts === 1) {
          throw new Error("simulated failure before commit");
        }
        storedPreferences ??= {
          ...request.preferences,
          featureFlags: {
            ...request.preferences.featureFlags,
            [standaloneAgentModeFlag]: true
          }
        };
      } else {
        replaceAttempts++;
        assert.ok(storedPreferences, "replace must follow initialization");
        storedPreferences = request.preferences;
      }
      return { initialized: true, preferences: storedPreferences };
    }
  };

  const hostPreferences = await createDesktopHostPreferencesState({
    appVersion: installedVersion,
    fallbackLocale: "zh-CN",
    isPackaged: true,
    logger: createLogger(),
    migrationStateRootDir,
    tuttidClient: api
  });
  assert.equal(
    hostPreferences.getFeatureFlags()[standaloneAgentModeFlag],
    true
  );
  assert.equal(storedPreferences, null);

  const rendererPreferences = createRendererPreferences(
    api,
    hostPreferences.ensureInitialized
  );
  await rendererPreferences.whenInitialPreferencesHydrated();
  assert.equal(storedPreferences, null);
  assert.equal(sessionPatchAttempts, 0);
  assert.equal(
    rendererPreferences.store.featureFlags[standaloneAgentModeFlag],
    true
  );
  await assert.rejects(readFile(installedVersionStatePath, "utf8"), {
    code: "ENOENT"
  });

  await rendererPreferences.rememberAgentSessionLaunchMode(
    "workspace-a",
    "project:/alpha",
    "worktree"
  );
  rendererPreferences.dispose();

  const persisted = await api.getDesktopPreferences();
  assert.equal(initializationAttempts, 2);
  assert.equal(replaceAttempts, 0);
  assert.equal(sessionPatchAttempts, 1);
  assert.equal(persisted.initialized, true);
  assert.equal(persisted.preferences.locale, "zh-CN");
  assert.equal(persisted.preferences.minimizeAnimation, "genie");
  assert.equal(persisted.preferences.updateChannel, "rc");
  assert.equal(
    persisted.preferences.featureFlags[standaloneAgentModeFlag],
    true
  );
  assert.equal(
    persisted.preferences.agentSessionLaunchModesByWorkspace?.["workspace-a"]?.[
      "project:/alpha"
    ],
    "worktree"
  );
  assert.equal(
    await readFile(installedVersionStatePath, "utf8"),
    installedVersion
  );

  const restartedHostPreferences = await createDesktopHostPreferencesState({
    appVersion: installedVersion,
    fallbackLocale: "en",
    isPackaged: true,
    logger: createLogger(),
    migrationStateRootDir,
    tuttidClient: api
  });
  assert.equal(restartedHostPreferences.getLocale(), "zh-CN");
  assert.equal(restartedHostPreferences.getMinimizeAnimation(), "genie");
  assert.equal(restartedHostPreferences.getUpdateChannel(), "rc");
  assert.equal(
    restartedHostPreferences.getFeatureFlags()[standaloneAgentModeFlag],
    true
  );

  const restartedRendererPreferences = createRendererPreferences(
    api,
    restartedHostPreferences.ensureInitialized
  );
  await restartedRendererPreferences.whenInitialPreferencesHydrated();
  assert.equal(
    restartedRendererPreferences.store.agentSessionLaunchModesByWorkspace[
      "workspace-a"
    ]?.["project:/alpha"],
    "worktree"
  );
  restartedRendererPreferences.dispose();
  assert.equal(initializationAttempts, 2);
  assert.equal(replaceAttempts, 0);
  assert.equal(sessionPatchAttempts, 1);
});

interface PreferencesApi {
  getDesktopPreferences(): Promise<DesktopPreferencesStateResponse>;
  patchAgentSessionLaunchMode(input: SessionLaunchModePatch): Promise<void>;
  putDesktopPreferences(
    request: PutDesktopPreferencesRequest
  ): Promise<DesktopPreferencesStateResponse>;
}

function createRendererPreferences(
  api: PreferencesApi,
  ensureInitialized: () => Promise<DesktopPreferencesStateResponse>
): DesktopPreferencesService {
  return new DesktopPreferencesService({
    applyLocale() {},
    applyTheme() {},
    client: createRendererClient(api),
    ensureInitialized,
    initialLocale: "zh-CN",
    initialTheme: { appearance: "dark", source: "dark" },
    initialWorkspaceUiMode: "agent",
    resolveTheme: (source) => ({
      appearance: source === "light" ? "light" : "dark",
      source
    })
  });
}

function createRendererClient(api: PreferencesApi): DesktopPreferencesClient {
  return {
    async connect() {},
    dispose() {},
    getDesktopPreferences: () => api.getDesktopPreferences(),
    async patchAgentComposerDefaultsForTarget() {
      throw new Error("unexpected agent composer defaults patch");
    },
    patchAgentSessionLaunchMode: (input) =>
      api.patchAgentSessionLaunchMode(input),
    subscribeToDesktopPreferencesUpdated() {
      return () => {};
    },
    async updateDesktopPreferences(request) {
      return (await api.putDesktopPreferences(request)).preferences;
    }
  };
}

function createDaemonDefaults(): Preferences {
  return {
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
    featureFlags: { [standaloneAgentModeFlag]: true },
    fileDefaultOpenersByExtension: {},
    locale: "en",
    minimizeAnimation: "scale",
    showAppDeveloperSources: false,
    sleepPreventionMode: "never",
    themeSource: "dark",
    updateChannel: "stable",
    updatePolicy: "prompt",
    workbenchShortcuts: defaultDesktopWorkbenchShortcuts
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
