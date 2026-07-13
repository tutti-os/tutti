import assert from "node:assert/strict";
import test from "node:test";
import type { DesktopFusionApi } from "@preload/types";
import type { DesktopFusionOpenWindowInput } from "@shared/contracts/fusion.ts";
import type { IWorkspaceAppCenterService } from "@renderer/features/workspace-app-center";
import { createFusionNativeLaunchAdapter } from "./fusionNativeLaunchAdapter.ts";
import { openStandaloneFusionFeatureRequest } from "./useStandaloneFusionLaunchCoordinators.ts";

test("Fusion native launch adapter force-creates payload-bearing windows", async () => {
  const opened: DesktopFusionOpenWindowInput[] = [];
  const adapter = createFusionNativeLaunchAdapter({
    fusionApi: createFusionApi(opened),
    workspaceId: "workspace-1"
  });

  await adapter.openBrowser({
    url: "https://example.com/path",
    workspaceId: "workspace-1"
  });
  await adapter.openAgent({
    autoSubmit: true,
    draftPrompt: "draft",
    openInNewWindow: false,
    provider: "codex",
    workspaceId: "workspace-1"
  });
  await adapter.openSettings({ anchor: "computer-use", section: "general" });

  assert.deepEqual(
    opened.map((request) => ({
      forceNew: request.forceNew,
      kind: request.kind,
      launchPayload: request.launchPayload
    })),
    [
      {
        forceNew: true,
        kind: "browser",
        launchPayload: { url: "https://example.com/path" }
      },
      {
        forceNew: true,
        kind: "agent",
        launchPayload: {
          autoSubmit: true,
          draftPrompt: "draft",
          provider: "codex"
        }
      },
      {
        forceNew: true,
        kind: "settings",
        launchPayload: { anchor: "computer-use", section: "general" }
      }
    ]
  );
});

test("Fusion generic Workspace App launch keeps route state for target-owner prepublish", async () => {
  const opened: DesktopFusionOpenWindowInput[] = [];
  const adapter = createFusionNativeLaunchAdapter({
    fusionApi: createFusionApi(opened),
    workspaceId: "workspace-1"
  });
  const intent = {
    kind: "open-route" as const,
    route: "/review",
    state: { selectedIds: ["one", "two"] }
  };

  await adapter.openWorkbenchNode({
    payload: { appId: "review-app", intent },
    typeId: "workspace-app-webview"
  });

  assert.deepEqual(opened[0], {
    forceNew: true,
    kind: "workspace-app",
    launchPayload: { appId: "review-app", intent },
    resourceId: "review-app",
    workspaceId: "workspace-1"
  });
});

test("Fusion Workspace App launcher can reuse an exact resource after App Center prepares it", async () => {
  const opened: DesktopFusionOpenWindowInput[] = [];
  const adapter = createFusionNativeLaunchAdapter({
    fusionApi: createFusionApi(opened),
    workspaceId: "workspace-1"
  });

  await adapter.openWorkspaceApp({
    appId: "notes",
    forceNew: false,
    prepared: true,
    prevStatus: "idle"
  });

  assert.deepEqual(opened[0], {
    forceNew: false,
    kind: "workspace-app",
    launchPayload: {
      appId: "notes",
      prepared: true,
      prevStatus: "idle"
    },
    resourceId: "notes",
    workspaceId: "workspace-1"
  });
});

test("Fusion Agent launcher always reuses an existing session unless New Window is explicit", async () => {
  const opened: DesktopFusionOpenWindowInput[] = [];
  const adapter = createFusionNativeLaunchAdapter({
    fusionApi: createFusionApi(opened),
    workspaceId: "workspace-1"
  });

  await adapter.openAgent({
    agentSessionId: "session-existing",
    openInNewWindow: false,
    workspaceId: "workspace-1"
  });
  await adapter.openAgent({
    agentSessionId: "session-existing",
    agentTargetId: "target-existing",
    draftPrompt: "start another turn",
    openInNewWindow: false,
    provider: "codex",
    workspaceId: "workspace-1"
  });
  await adapter.openAgent({
    draftPrompt: "start fresh work",
    openInNewWindow: false,
    provider: "codex",
    workspaceId: "workspace-1"
  });
  await adapter.openAgent({
    agentSessionId: "session-existing",
    openInNewWindow: true,
    workspaceId: "workspace-1"
  });

  assert.deepEqual(
    opened.map((request) => ({
      forceNew: request.forceNew,
      resourceId: request.resourceId
    })),
    [
      { forceNew: false, resourceId: "session-existing" },
      { forceNew: false, resourceId: "session-existing" },
      { forceNew: true, resourceId: null },
      { forceNew: true, resourceId: "session-existing" }
    ]
  );
});

test("Fusion group chat refreshes a cold App Center store and preserves the legacy deep link", async () => {
  const opened: DesktopFusionOpenWindowInput[] = [];
  let apps: unknown[] = [];
  let refreshCount = 0;
  const appCenterService = {
    get store() {
      return { apps };
    },
    async refresh() {
      refreshCount += 1;
      apps = [
        {
          appId: "group-chat",
          launchUrl: "http://127.0.0.1:4100/"
        }
      ];
    }
  } as unknown as IWorkspaceAppCenterService;
  const adapter = createFusionNativeLaunchAdapter({
    appCenterService,
    fusionApi: createFusionApi(opened),
    workspaceId: "workspace-1"
  });

  assert.equal(
    await adapter.openGroupChat({
      conversationId: "conversation-1",
      messageId: "message-1",
      summaryTaskId: "summary-1",
      workspaceId: "workspace-1"
    }),
    true
  );
  assert.equal(refreshCount, 1);
  assert.deepEqual(opened[0]?.launchPayload, {
    appId: "group-chat",
    url: "http://127.0.0.1:4100/#nav?messageId=message-1&summaryTaskId=summary-1&conversationId=conversation-1"
  });
});

test("Fusion feature adapter preserves the complete native feature matrix", async () => {
  const opened: DesktopFusionOpenWindowInput[] = [];
  const adapter = createFusionNativeLaunchAdapter({
    fusionApi: createFusionApi(opened),
    workspaceId: "workspace-1"
  });

  assert.equal(
    await openStandaloneFusionFeatureRequest({
      adapter,
      request: {
        autoSubmit: true,
        draftPrompt: "continue",
        feature: "agent-chat",
        provider: "codex"
      },
      workspaceId: "workspace-1"
    }),
    true
  );
  assert.equal(
    await openStandaloneFusionFeatureRequest({
      adapter,
      request: { feature: "message-center" },
      workspaceId: "workspace-1"
    }),
    true
  );
  for (const feature of ["agent-connect", "agent-manage"] as const) {
    assert.equal(
      await openStandaloneFusionFeatureRequest({
        adapter,
        request: { feature, provider: "codex" },
        workspaceId: "workspace-1"
      }),
      true
    );
  }
  assert.deepEqual(opened[0], {
    forceNew: true,
    kind: "agent",
    launchPayload: {
      autoSubmit: true,
      draftPrompt: "continue",
      provider: "codex"
    },
    resourceId: null,
    workspaceId: "workspace-1"
  });
  assert.deepEqual(opened[1], {
    forceNew: true,
    kind: "agent",
    launchPayload: { agentFeature: "message-center" },
    workspaceId: "workspace-1"
  });
  assert.deepEqual(
    opened.slice(2).map((request) => request.launchPayload),
    [
      { agentFeature: "connect", provider: "codex" },
      { agentFeature: "manage", provider: "codex" }
    ]
  );
});

function createFusionApi(
  opened: DesktopFusionOpenWindowInput[]
): DesktopFusionApi {
  return {
    async closeWindow() {},
    async focusWindow() {},
    async getState() {
      return {
        active: true,
        dockSearchExpanded: false,
        dockSearchScope: "all",
        dockVisible: true,
        revision: 0,
        shortcut: { binding: null, error: null },
        windows: [],
        workspaceId: "workspace-1"
      };
    },
    async hideDock() {},
    async openWindow(input) {
      opened.push(input);
      return {
        createdAtUnixMs: 1,
        focused: true,
        kind: input.kind,
        lastFocusedAtUnixMs: 1,
        resourceId: input.resourceId ?? null,
        title: input.title ?? null,
        visibility: "visible",
        windowInstanceId: `window-${opened.length}`,
        workspaceId: input.workspaceId
      };
    },
    onState() {
      return () => undefined;
    },
    async showDock() {},
    async toggleDock() {},
    async updateWindow() {
      throw new Error("not used");
    }
  };
}
