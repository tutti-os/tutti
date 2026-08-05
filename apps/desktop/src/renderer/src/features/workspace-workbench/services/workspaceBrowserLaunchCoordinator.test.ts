import assert from "node:assert/strict";
import test from "node:test";
import {
  registerWorkspaceBrowserLaunchHandler,
  requestWorkspaceBrowserHostFileLaunch,
  requestWorkspaceBrowserLaunch,
  requestWorkspaceBrowserSurfaceFocus,
  type WorkspaceBrowserLaunchRequest
} from "./workspaceBrowserLaunchCoordinator.ts";

test("workspace browser launch coordinator dispatches normalized URL requests", async () => {
  const requests: WorkspaceBrowserLaunchRequest[] = [];
  const dispose = registerWorkspaceBrowserLaunchHandler(
    " workspace-1 ",
    (request) => {
      requests.push(request);
      return "browser:one";
    }
  );

  assert.equal(
    await requestWorkspaceBrowserLaunch({
      url: " http://localhost:9999 ",
      workspaceId: " workspace-1 "
    }),
    true
  );
  dispose();
  assert.equal(
    await requestWorkspaceBrowserLaunch({
      url: "http://localhost:9999",
      workspaceId: "workspace-1"
    }),
    false
  );
  assert.deepEqual(requests, [
    {
      kind: "open",
      reuseIfOpen: undefined,
      url: "http://localhost:9999/",
      workspaceId: "workspace-1"
    }
  ]);
});

test("workspace browser launch coordinator preserves reuse preference", async () => {
  const requests: WorkspaceBrowserLaunchRequest[] = [];
  const dispose = registerWorkspaceBrowserLaunchHandler(
    "workspace-reuse",
    (request) => {
      requests.push(request);
      return "browser:new";
    }
  );

  assert.equal(
    await requestWorkspaceBrowserLaunch({
      reuseIfOpen: false,
      source: "workspace_app",
      sourceNodeId: " workspace-app:99 ",
      url: "https://example.com/new-window",
      workspaceId: "workspace-reuse"
    }),
    true
  );
  dispose();

  assert.deepEqual(requests, [
    {
      kind: "open",
      reuseIfOpen: false,
      source: "workspace_app",
      sourceNodeId: "workspace-app:99",
      url: "https://example.com/new-window",
      workspaceId: "workspace-reuse"
    }
  ]);
});

test("workspace browser launch coordinator focuses an exact Browser surface", async () => {
  const requests: WorkspaceBrowserLaunchRequest[] = [];
  const dispose = registerWorkspaceBrowserLaunchHandler(
    "workspace-focus",
    (request) => {
      requests.push(request);
      return "browser:window-1";
    }
  );

  assert.equal(
    await requestWorkspaceBrowserSurfaceFocus({
      preferredNodeId: " browser:window-1 ",
      workspaceId: " workspace-focus "
    }),
    "browser:window-1"
  );
  dispose();
  assert.deepEqual(requests, [
    {
      kind: "focus",
      preferredNodeId: "browser:window-1",
      workspaceId: "workspace-focus"
    }
  ]);
});

test("workspace browser launch coordinator rejects unsupported URLs", async () => {
  const requests: unknown[] = [];
  const dispose = registerWorkspaceBrowserLaunchHandler(
    "workspace-urls",
    (request) => {
      requests.push(request);
      return "browser:one";
    }
  );

  assert.equal(
    await requestWorkspaceBrowserLaunch({
      url: "file:///tmp/index.html",
      workspaceId: "workspace-urls"
    }),
    false
  );
  assert.equal(
    await requestWorkspaceBrowserLaunch({
      url: "javascript:alert(1)",
      workspaceId: "workspace-urls"
    }),
    false
  );
  assert.equal(
    await requestWorkspaceBrowserLaunch({
      url: "not a url",
      workspaceId: "workspace-urls"
    }),
    false
  );
  dispose();
  assert.deepEqual(requests, []);
});

test("workspace browser host file launch coordinator dispatches file URLs", async () => {
  const requests: WorkspaceBrowserLaunchRequest[] = [];
  const dispose = registerWorkspaceBrowserLaunchHandler(
    "workspace-files",
    (request) => {
      requests.push(request);
      return "browser:file";
    }
  );

  assert.equal(
    await requestWorkspaceBrowserHostFileLaunch({
      url: "file:///Users/local/project/index.html",
      workspaceId: "workspace-files"
    }),
    true
  );
  dispose();

  assert.deepEqual(requests, [
    {
      kind: "open",
      reuseIfOpen: undefined,
      source: "file_manager",
      url: "file:///Users/local/project/index.html",
      workspaceId: "workspace-files"
    }
  ]);
});

test("workspace browser launch coordinator preserves fallback when handler declines", async () => {
  const dispose = registerWorkspaceBrowserLaunchHandler(
    "workspace-declined",
    () => null
  );

  assert.equal(
    await requestWorkspaceBrowserLaunch({
      url: "https://example.com",
      workspaceId: "workspace-declined"
    }),
    false
  );
  dispose();
});
