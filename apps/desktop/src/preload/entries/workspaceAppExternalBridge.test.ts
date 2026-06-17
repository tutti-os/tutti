import assert from "node:assert/strict";
import test from "node:test";
import {
  createWorkspaceAppExternalBridge,
  requireUserActivation,
  workspaceAppExternalChannels
} from "./workspaceAppExternalBridge.ts";
import type { DesktopWorkspaceAppContext } from "../../shared/contracts/ipc.ts";

test("workspace app external bridge proxies app context", async () => {
  const context: DesktopWorkspaceAppContext = {
    appId: "automation",
    locale: "en",
    workspaceId: "workspace-1"
  };
  const bridge = createWorkspaceAppExternalBridge({
    appContext: {
      async get() {
        return context;
      },
      subscribe() {
        throw new Error("unexpected subscribe");
      }
    },
    isUserActivationActive: () => true,
    async invoke() {
      throw new Error("unexpected invoke");
    }
  });

  assert.equal(await bridge.app.getContext(), context);
});

test("workspace app external bridge subscribes to app context", () => {
  const context: DesktopWorkspaceAppContext = {
    appId: "automation",
    locale: "zh-CN",
    workspaceId: "workspace-1"
  };
  const bridge = createWorkspaceAppExternalBridge({
    appContext: {
      async get() {
        throw new Error("unexpected get");
      },
      subscribe(listener) {
        listener(context);
        return () => undefined;
      }
    },
    isUserActivationActive: () => true,
    async invoke() {
      throw new Error("unexpected invoke");
    }
  });
  const contexts: unknown[] = [];
  const unsubscribe = bridge.app.subscribe((nextContext) => {
    contexts.push(nextContext);
  });

  unsubscribe();
  assert.deepEqual(contexts, [context]);
});

test("workspace app external bridge invokes at query without user activation", async () => {
  const calls: Array<{ channel: string; payload?: unknown }> = [];
  const bridge = createWorkspaceAppExternalBridge({
    appContext: {
      async get() {
        return { locale: "en" };
      },
      subscribe() {
        throw new Error("unexpected subscribe");
      }
    },
    isUserActivationActive: () => false,
    async invoke<TResult>(channel: string, payload?: unknown) {
      calls.push({ channel, payload });
      return [
        {
          providerId: "file",
          itemId: "README.md",
          label: "README.md",
          insert: {
            kind: "markdown-link",
            label: "README.md",
            href: "README.md"
          }
        }
      ] as TResult;
    }
  });

  assert.deepEqual(await bridge.at.query({ keyword: "readme" }), [
    {
      providerId: "file",
      itemId: "README.md",
      label: "README.md",
      insert: {
        kind: "markdown-link",
        label: "README.md",
        href: "README.md"
      }
    }
  ]);
  assert.deepEqual(calls, [
    {
      channel: workspaceAppExternalChannels.atQuery,
      payload: { keyword: "readme" }
    }
  ]);
});

test("workspace app external bridge requires activation for file select", async () => {
  const bridge = createWorkspaceAppExternalBridge({
    appContext: {
      async get() {
        return { locale: "en" };
      },
      subscribe() {
        throw new Error("unexpected subscribe");
      }
    },
    isUserActivationActive: () => false,
    async invoke() {
      throw new Error("unexpected invoke");
    }
  });

  assert.throws(
    () => bridge.files.select({ multiple: true }),
    /files\.select requires a user action/
  );
});

test("workspace app external bridge invokes file select with activation", async () => {
  const calls: Array<{ channel: string; payload?: unknown }> = [];
  const bridge = createWorkspaceAppExternalBridge({
    appContext: {
      async get() {
        return { locale: "en" };
      },
      subscribe() {
        throw new Error("unexpected subscribe");
      }
    },
    isUserActivationActive: () => true,
    async invoke<TResult>(channel: string, payload?: unknown) {
      calls.push({ channel, payload });
      return [
        {
          kind: "file",
          path: "README.md"
        }
      ] as TResult;
    }
  });

  assert.deepEqual(await bridge.files.select({ multiple: true }), [
    {
      kind: "file",
      path: "README.md"
    }
  ]);
  assert.deepEqual(calls, [
    {
      channel: workspaceAppExternalChannels.filesSelect,
      payload: { multiple: true }
    }
  ]);
});

test("requireUserActivation throws only when inactive", () => {
  assert.doesNotThrow(() => requireUserActivation(true, "files.select"));
  assert.throws(
    () => requireUserActivation(false, "files.select"),
    /files\.select requires a user action/
  );
});
