import assert from "node:assert/strict";
import test from "node:test";
import {
  registerGroupChatLaunchHandler,
  requestGroupChatLaunch
} from "./groupChatLaunchCoordinator.ts";
import {
  registerWorkspaceBrowserLaunchHandler,
  requestWorkspaceBrowserLaunch
} from "./workspaceBrowserLaunchCoordinator.ts";
import {
  registerWorkspaceFilesLaunchHandler,
  requestWorkspaceFilesLaunch
} from "./workspaceFilesLaunchCoordinator.ts";
import {
  registerWorkspaceMessageCenterOpenHandler,
  requestWorkspaceMessageCenterOpen
} from "./workspaceMessageCenterCoordinator.ts";
import {
  registerWorkspaceWorkbenchNodeLaunchHandler,
  requestWorkspaceWorkbenchNodeLaunch
} from "./workspaceWorkbenchNodeLaunchCoordinator.ts";

test("group chat coordinator keeps a replacement after stale disposal", async () => {
  const calls: string[] = [];
  const disposeFirst = registerGroupChatLaunchHandler(
    "workspace-group-chat-registration",
    () => {
      calls.push("first");
      return false;
    }
  );
  const disposeReplacement = registerGroupChatLaunchHandler(
    "workspace-group-chat-registration",
    () => {
      calls.push("replacement");
      return true;
    }
  );

  disposeFirst();

  assert.equal(
    await requestGroupChatLaunch({
      workspaceId: "workspace-group-chat-registration"
    }),
    true
  );
  assert.deepEqual(calls, ["replacement"]);
  disposeReplacement();
});

test("browser coordinator keeps a replacement after stale disposal", async () => {
  const calls: string[] = [];
  const disposeFirst = registerWorkspaceBrowserLaunchHandler(
    "workspace-browser-registration",
    () => {
      calls.push("first");
      return false;
    }
  );
  const disposeReplacement = registerWorkspaceBrowserLaunchHandler(
    "workspace-browser-registration",
    () => {
      calls.push("replacement");
      return true;
    }
  );

  disposeFirst();

  assert.equal(
    await requestWorkspaceBrowserLaunch({
      url: "https://example.com",
      workspaceId: "workspace-browser-registration"
    }),
    true
  );
  assert.deepEqual(calls, ["replacement"]);
  disposeReplacement();
});

test("files coordinator keeps a replacement after stale disposal", async () => {
  const calls: string[] = [];
  const disposeFirst = registerWorkspaceFilesLaunchHandler(
    "workspace-files-registration",
    () => {
      calls.push("first");
      return false;
    }
  );
  const disposeReplacement = registerWorkspaceFilesLaunchHandler(
    "workspace-files-registration",
    () => {
      calls.push("replacement");
      return true;
    }
  );

  disposeFirst();

  assert.equal(
    await requestWorkspaceFilesLaunch({
      path: "/workspace/notes.txt",
      workspaceId: "workspace-files-registration"
    }),
    true
  );
  assert.deepEqual(calls, ["replacement"]);
  disposeReplacement();
});

test("message center coordinator keeps a replacement after stale disposal", () => {
  const calls: string[] = [];
  const disposeFirst = registerWorkspaceMessageCenterOpenHandler(
    "workspace-message-center-registration",
    () => calls.push("first")
  );
  const disposeReplacement = registerWorkspaceMessageCenterOpenHandler(
    "workspace-message-center-registration",
    () => calls.push("replacement")
  );

  disposeFirst();

  assert.equal(
    requestWorkspaceMessageCenterOpen(
      " workspace-message-center-registration "
    ),
    true
  );
  assert.deepEqual(calls, ["replacement"]);
  disposeReplacement();
});

test("workbench node coordinator keeps a replacement after stale disposal", async () => {
  const calls: string[] = [];
  const disposeFirst = registerWorkspaceWorkbenchNodeLaunchHandler(
    "workspace-node-registration",
    () => {
      calls.push("first");
      return false;
    }
  );
  const disposeReplacement = registerWorkspaceWorkbenchNodeLaunchHandler(
    "workspace-node-registration",
    () => {
      calls.push("replacement");
      return true;
    }
  );

  disposeFirst();

  assert.equal(
    await requestWorkspaceWorkbenchNodeLaunch({
      typeId: "workspace-node",
      workspaceId: "workspace-node-registration"
    }),
    true
  );
  assert.deepEqual(calls, ["replacement"]);
  disposeReplacement();
});
