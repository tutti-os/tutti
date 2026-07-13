import assert from "node:assert/strict";
import test from "node:test";
import type { DesktopWorkspaceAppExternalHostApi } from "@preload/types";
import type { IWorkspaceAppCenterService } from "@renderer/features/workspace-app-center";
import {
  publishWorkspaceAppLaunchIntent,
  readWorkspaceAppLaunchIntentEvent,
  shouldPublishWorkspaceAppLaunchIntentBeforeLaunch
} from "./workspaceAppLaunchIntent.ts";

test("Workspace App launch intent preserves non-URL state for target-owner prepublish", () => {
  const payload = {
    appId: "docs",
    intent: {
      kind: "open-route",
      params: { mode: "preview" },
      route: "/files",
      state: { selectedPaths: ["/tmp/a.md", "/tmp/b.md"] }
    }
  };
  const sent: unknown[] = [];
  const api = {
    onRequest() {
      return () => undefined;
    },
    sendEvent(event) {
      sent.push(event);
    }
  } satisfies DesktopWorkspaceAppExternalHostApi;

  publishWorkspaceAppLaunchIntent({
    api,
    payload,
    typeId: "workspace-app-webview",
    workspaceId: "workspace-1"
  });

  assert.deepEqual(sent, [
    {
      appId: "docs",
      intent: payload.intent,
      type: "workspace.launchIntent",
      workspaceId: "workspace-1"
    }
  ]);
});

test("pending-restart prepublish is required only when a route intent exists", () => {
  const service = {
    store: {
      apps: [{ appId: "docs", runtimeStatus: "installed_pending_restart" }]
    }
  } as IWorkspaceAppCenterService;
  assert.equal(
    shouldPublishWorkspaceAppLaunchIntentBeforeLaunch({
      appCenterService: service,
      payload: {
        appId: "docs",
        intent: { kind: "open-route", route: "/files", state: { id: 1 } }
      },
      typeId: "workspace-app-webview"
    }),
    true
  );
  assert.equal(
    shouldPublishWorkspaceAppLaunchIntentBeforeLaunch({
      appCenterService: service,
      payload: { appId: "docs" },
      typeId: "workspace-app-webview"
    }),
    false
  );
  assert.equal(
    readWorkspaceAppLaunchIntentEvent({ appId: "docs" }, "ws"),
    null
  );
});
