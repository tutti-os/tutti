import assert from "node:assert/strict";
import test from "node:test";
import type { DesktopWorkspaceAppContext } from "../../shared/contracts/ipc.ts";
import {
  createWorkspaceAppContextStore,
  isWorkspaceAppContext,
  isWorkspaceAppContextPatch
} from "./workspaceAppContextStore.ts";

const initialContext: DesktopWorkspaceAppContext = {
  agentBound: false,
  appId: "ai-canvas",
  capabilities: ["files.open@1", "files.upload@1"],
  contextToken: "context-token",
  installationId: "workspace-1:ai-canvas",
  issuer: "http://127.0.0.1:41234",
  launchIntent: {
    kind: "open-route",
    params: { mode: "preview" },
    route: "/assets",
    state: { assetId: "asset-1" }
  },
  locale: "en",
  workspaceId: "workspace-1"
};

test("workspace app context store merges consecutive patches without losing identity", async () => {
  const store = createWorkspaceAppContextStore({
    async load() {
      return initialContext;
    }
  });

  assert.deepEqual(await store.get(), initialContext);
  store.publish({ agentBound: true });
  store.publish({ locale: "zh-CN" });

  assert.deepEqual(await store.get(), {
    ...initialContext,
    agentBound: true,
    locale: "zh-CN"
  });
});

test("workspace app context store applies patches received before initial context", async () => {
  let resolveContext: ((context: DesktopWorkspaceAppContext) => void) | null =
    null;
  const store = createWorkspaceAppContextStore({
    load() {
      return new Promise((resolve) => {
        resolveContext = resolve;
      });
    }
  });
  const contexts: DesktopWorkspaceAppContext[] = [];
  store.subscribe((context) => {
    contexts.push(context);
  });

  store.publish({ agentBound: true });
  store.publish({ locale: "zh-CN" });
  assert.ok(resolveContext);
  (resolveContext as (context: DesktopWorkspaceAppContext) => void)(
    initialContext
  );
  await waitForMicrotasks();

  const expected = {
    ...initialContext,
    agentBound: true,
    locale: "zh-CN" as const
  };
  assert.deepEqual(await store.get(), expected);
  assert.deepEqual(contexts, [expected]);
});

test("workspace app context store does not replay stale state after a newer patch", async () => {
  const store = createWorkspaceAppContextStore({
    async load() {
      return initialContext;
    }
  });
  await store.get();
  const contexts: DesktopWorkspaceAppContext[] = [];

  store.subscribe((context) => {
    contexts.push(context);
  });
  store.publish({ locale: "zh-CN" });
  await waitForMicrotasks();

  assert.deepEqual(contexts, [{ ...initialContext, locale: "zh-CN" }]);
});

test("workspace app context get returns a patch received while the load settles", async () => {
  let resolveContext: ((context: DesktopWorkspaceAppContext) => void) | null =
    null;
  const store = createWorkspaceAppContextStore({
    load() {
      return new Promise((resolve) => {
        resolveContext = resolve;
      });
    }
  });

  const contextPromise = store.get();
  assert.ok(resolveContext);
  (resolveContext as (context: DesktopWorkspaceAppContext) => void)(
    initialContext
  );
  await Promise.resolve();
  store.publish({ agentBound: true });

  assert.deepEqual(await contextPromise, {
    ...initialContext,
    agentBound: true
  });
});

test("workspace app context validators enforce full snapshots and narrow patches", () => {
  assert.equal(isWorkspaceAppContext(initialContext), true);
  assert.equal(
    isWorkspaceAppContext({ ...initialContext, contextToken: 123 }),
    false
  );
  assert.equal(isWorkspaceAppContext({ locale: "fr" }), false);
  assert.equal(isWorkspaceAppContextPatch({ agentBound: true }), true);
  assert.equal(isWorkspaceAppContextPatch({ locale: "zh-CN" }), true);
  assert.equal(isWorkspaceAppContextPatch({ locale: "fr" }), false);
  assert.equal(isWorkspaceAppContextPatch({ locale: undefined }), false);
  assert.equal(isWorkspaceAppContextPatch({ agentBound: undefined }), false);
  assert.equal(
    isWorkspaceAppContextPatch({ contextToken: "replacement" }),
    false
  );
});

function waitForMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
