import assert from "node:assert/strict";
import test from "node:test";
import { WorkspaceAppLaunchIntentStore } from "./workspaceAppLaunchIntentStore.ts";

const intent = {
  kind: "open-route" as const,
  route: "/messages",
  state: { selected: "message-1" }
};

test("Workspace App launch intents are consumed once by the target owner", () => {
  const store = new WorkspaceAppLaunchIntentStore();
  const identity = {
    appID: "chat",
    ownerWebContentsId: 41,
    workspaceID: "workspace-a"
  };
  store.set(identity, intent);

  assert.deepEqual(store.take(identity), intent);
  assert.equal(store.take(identity), null);
});

test("Workspace App launch intents are cleared when their owner is destroyed", () => {
  const store = new WorkspaceAppLaunchIntentStore();
  store.set(
    { appID: "chat", ownerWebContentsId: 41, workspaceID: "workspace-a" },
    intent
  );
  store.set(
    { appID: "docs", ownerWebContentsId: 41, workspaceID: "workspace-b" },
    intent
  );
  store.set(
    { appID: "chat", ownerWebContentsId: 42, workspaceID: "workspace-a" },
    intent
  );

  store.forgetOwner(41);

  assert.equal(
    store.take({
      appID: "chat",
      ownerWebContentsId: 41,
      workspaceID: "workspace-a"
    }),
    null
  );
  assert.equal(
    store.take({
      appID: "docs",
      ownerWebContentsId: 41,
      workspaceID: "workspace-b"
    }),
    null
  );
  assert.deepEqual(
    store.take({
      appID: "chat",
      ownerWebContentsId: 42,
      workspaceID: "workspace-a"
    }),
    intent
  );
});
