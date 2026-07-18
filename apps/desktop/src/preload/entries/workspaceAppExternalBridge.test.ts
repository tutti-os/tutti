import assert from "node:assert/strict";
import test from "node:test";
import {
  createWorkspaceAppExternalBridge,
  requireUserActivation,
  workspaceAppExternalChannels
} from "./workspaceAppExternalBridge.ts";
import type { DesktopWorkspaceAppContext } from "../../shared/contracts/ipc.ts";

function unexpectedSend(): void {
  throw new Error("unexpected send");
}

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
    send: unexpectedSend,
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
    send: unexpectedSend,
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

test("workspace app external bridge replays initial launch intent from app context", async () => {
  const intent = {
    kind: "open-route" as const,
    params: { mode: "preview" },
    route: "/files",
    state: { selectedPath: "/tmp/a.md" }
  };
  const bridge = createWorkspaceAppExternalBridge({
    appContext: {
      async get() {
        return {
          appId: "docs",
          launchIntent: intent,
          locale: "en",
          workspaceId: "workspace-1"
        };
      },
      subscribe() {
        throw new Error("unexpected subscribe");
      }
    },
    isUserActivationActive: () => true,
    send: unexpectedSend,
    subscribeToWorkspaceLaunchIntents() {
      return () => undefined;
    },
    async invoke() {
      throw new Error("unexpected invoke");
    }
  });
  const intents: unknown[] = [];

  const unsubscribe = bridge.workspace.onLaunchIntent((nextIntent) => {
    intents.push(nextIntent);
  });
  await new Promise((resolve) => setImmediate(resolve));

  unsubscribe();
  const unsubscribeAgain = bridge.workspace.onLaunchIntent((nextIntent) => {
    intents.push(nextIntent);
  });
  await new Promise((resolve) => setImmediate(resolve));

  unsubscribeAgain();
  assert.deepEqual(intents, [intent]);
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
    send: unexpectedSend,
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

test("workspace app external bridge resolves mentions without user activation", async () => {
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
    send: unexpectedSend,
    async invoke<TResult>(channel: string, payload?: unknown) {
      calls.push({ channel, payload });
      return {
        label: "Canvas",
        presentation: { iconUrl: "tutti://app-icon/canvas" }
      } as TResult;
    }
  });

  assert.deepEqual(
    await bridge.at.resolve?.({
      providerId: "workspace-app",
      entityId: "canvas",
      scope: { workspaceId: "untrusted-workspace" }
    }),
    {
      label: "Canvas",
      presentation: { iconUrl: "tutti://app-icon/canvas" }
    }
  );
  assert.deepEqual(calls, [
    {
      channel: workspaceAppExternalChannels.atResolve,
      payload: {
        providerId: "workspace-app",
        entityId: "canvas",
        scope: { workspaceId: "untrusted-workspace" }
      }
    }
  ]);
});

test("workspace app external bridge subscribes to mention invalidation", () => {
  let publish:
    | ((event: { providerIds?: readonly ["workspace-app"] }) => void)
    | undefined;
  let unsubscribed = false;
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
    send: unexpectedSend,
    subscribeToAtInvalidations(listener) {
      publish = listener;
      return () => {
        unsubscribed = true;
      };
    },
    async invoke() {
      throw new Error("unexpected invoke");
    }
  });
  const events: unknown[] = [];

  const unsubscribe = bridge.at.subscribe?.((event) => events.push(event));
  publish?.({ providerIds: ["workspace-app"] });
  unsubscribe?.();

  assert.deepEqual(events, [{ providerIds: ["workspace-app"] }]);
  assert.equal(unsubscribed, true);
});

test("workspace app external bridge reports active without user activation", async () => {
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
    send: unexpectedSend,
    async invoke<TResult>(channel: string, payload?: unknown) {
      calls.push({ channel, payload });
      return undefined as TResult;
    }
  });

  await bridge.activity.reportActive();

  assert.deepEqual(calls, [
    {
      channel: workspaceAppExternalChannels.activityReportActive,
      payload: undefined
    }
  ]);
});

test("workspace app external bridge invokes workspace feature open", async () => {
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
    send: unexpectedSend,
    async invoke<TResult>(channel: string, payload?: unknown) {
      calls.push({ channel, payload });
      return undefined as TResult;
    }
  });

  await bridge.workspace.openFeature({
    feature: "agent-manage",
    provider: "codex"
  });

  assert.deepEqual(calls, [
    {
      channel: workspaceAppExternalChannels.workspaceFeatureOpen,
      payload: { feature: "agent-manage", provider: "codex" }
    }
  ]);
});

test("workspace app external bridge sends browser open URL requests", async () => {
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
    send(channel: string, payload?: unknown) {
      calls.push({ channel, payload });
    },
    async invoke() {
      throw new Error("unexpected invoke");
    }
  });

  await bridge.browser.openUrl({ url: "https://example.com/design" });

  assert.deepEqual(calls, [
    {
      channel: workspaceAppExternalChannels.browserOpenUrl,
      payload: { url: "https://example.com/design" }
    }
  ]);
});

test("workspace app external bridge requires activation for browser open URL", () => {
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
    send: unexpectedSend,
    async invoke() {
      throw new Error("unexpected invoke");
    }
  });

  assert.throws(
    () => bridge.browser.openUrl({ url: "https://example.com/design" }),
    /browser\.openUrl requires a user action/
  );
});

test("workspace app external bridge requires activation for workspace feature open", () => {
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
    send: unexpectedSend,
    async invoke() {
      throw new Error("unexpected invoke");
    }
  });

  assert.throws(
    () => bridge.workspace.openFeature({ feature: "message-center" }),
    /workspace\.openFeature requires a user action/
  );
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
    send: unexpectedSend,
    async invoke() {
      throw new Error("unexpected invoke");
    }
  });

  assert.throws(
    () => bridge.files.select({ multiple: true }),
    /files\.select requires a user action/
  );
});

test("workspace app external bridge requires activation for file open", async () => {
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
    send: unexpectedSend,
    async invoke() {
      throw new Error("unexpected invoke");
    }
  });

  assert.throws(
    () => bridge.files.open({ path: "README.md" }),
    /files\.open requires a user action/
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
    send: unexpectedSend,
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

test("workspace app external bridge invokes file open with activation", async () => {
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
    send: unexpectedSend,
    async invoke<TResult>(channel: string, payload?: unknown) {
      calls.push({ channel, payload });
      return undefined as TResult;
    }
  });

  await bridge.files.open({
    mode: "auto",
    name: "README.md",
    path: "README.md"
  });
  assert.deepEqual(calls, [
    {
      channel: workspaceAppExternalChannels.filesOpen,
      payload: {
        mode: "auto",
        name: "README.md",
        path: "README.md"
      }
    }
  ]);
});

test("workspace app external bridge uploads files without user activation", async () => {
  const calls: Array<{ channel: string; payload?: unknown }> = [];
  let fetchUrl = "";
  let fetchInit: RequestInit | undefined;
  const file = new Blob(["hello"], { type: "text/plain" }) as File;
  Object.defineProperty(file, "name", { value: "note.txt" });
  const bridge = createWorkspaceAppExternalBridge({
    appContext: {
      async get() {
        return { locale: "en" };
      },
      subscribe() {
        throw new Error("unexpected subscribe");
      }
    },
    async fetch(input, init) {
      fetchUrl = String(input);
      fetchInit = init;
      return new Response(null, { status: 204 });
    },
    isUserActivationActive: () => false,
    send: unexpectedSend,
    async invoke<TResult>(channel: string, payload?: unknown) {
      calls.push({ channel, payload });
      if (channel === workspaceAppExternalChannels.filesUploadPrepare) {
        return {
          expiresAt: "2026-06-24T12:15:00Z",
          headers: {
            Authorization: "Bearer app-token",
            "Content-Type": "application/octet-stream"
          },
          method: "PUT",
          uploadId: "upload-1",
          url: "http://127.0.0.1:4545/v1/workspaces/ws-1/apps/canvas/uploads/upload-1/content"
        } as TResult;
      }
      if (channel === workspaceAppExternalChannels.filesUploadComplete) {
        return {
          path: "/state/apps/installations/canvas/data/uploads/2c/hash.txt",
          name: "note.md",
          mimeType: "text/markdown",
          sizeBytes: 5,
          sha256: "hash"
        } as TResult;
      }
      throw new Error(`unexpected channel ${channel}`);
    }
  });

  const uploaded = await bridge.files.upload(file, {
    name: " note.md ",
    mimeType: " text/markdown "
  });

  assert.deepEqual(uploaded, {
    path: "/state/apps/installations/canvas/data/uploads/2c/hash.txt",
    name: "note.md",
    mimeType: "text/markdown",
    sizeBytes: 5,
    sha256: "hash"
  });
  assert.equal(
    fetchUrl,
    "http://127.0.0.1:4545/v1/workspaces/ws-1/apps/canvas/uploads/upload-1/content"
  );
  assert.equal(fetchInit?.method, "PUT");
  assert.equal(fetchInit?.body, file);
  assert.deepEqual(fetchInit?.headers, {
    Authorization: "Bearer app-token",
    "Content-Type": "application/octet-stream"
  });
  assert.deepEqual(calls, [
    {
      channel: workspaceAppExternalChannels.filesUploadPrepare,
      payload: {
        purpose: "app-asset",
        name: "note.md",
        mimeType: "text/markdown",
        sizeBytes: 5
      }
    },
    {
      channel: workspaceAppExternalChannels.filesUploadComplete,
      payload: { uploadId: "upload-1" }
    }
  ]);
});

test("workspace app external bridge reports upload progress", async () => {
  const calls: Array<{ channel: string; payload?: unknown }> = [];
  const progress: Array<{
    loadedBytes: number;
    ratio: number;
    totalBytes: number;
  }> = [];
  let sentBody: unknown;
  const file = new Blob(["hello"], { type: "text/plain" }) as File;
  Object.defineProperty(file, "name", { value: "note.txt" });
  const bridge = createWorkspaceAppExternalBridge({
    appContext: {
      async get() {
        return { locale: "en" };
      },
      subscribe() {
        throw new Error("unexpected subscribe");
      }
    },
    createXMLHttpRequest() {
      return {
        onabort: null,
        onerror: null,
        onload: null,
        status: 0,
        upload: { onprogress: null },
        abort() {
          this.onabort?.();
        },
        open() {
          return undefined;
        },
        send(body: Blob | File) {
          sentBody = body;
          this.upload?.onprogress?.({ loaded: 2, total: 5 });
          this.upload?.onprogress?.({ loaded: 5, total: 5 });
          this.status = 204;
          this.onload?.();
        },
        setRequestHeader() {
          return undefined;
        }
      };
    },
    isUserActivationActive: () => false,
    send: unexpectedSend,
    async invoke<TResult>(channel: string, payload?: unknown) {
      calls.push({ channel, payload });
      if (channel === workspaceAppExternalChannels.filesUploadPrepare) {
        return {
          expiresAt: "2026-06-24T12:15:00Z",
          headers: {
            Authorization: "Bearer app-token",
            "Content-Type": "application/octet-stream"
          },
          method: "PUT",
          uploadId: "upload-1",
          url: "http://127.0.0.1:4545/v1/workspaces/ws-1/apps/canvas/uploads/upload-1/content"
        } as TResult;
      }
      if (channel === workspaceAppExternalChannels.filesUploadComplete) {
        return {
          path: "/state/apps/installations/canvas/data/uploads/2c/hash.txt",
          name: "note.txt",
          mimeType: "text/plain",
          sizeBytes: 5,
          sha256: "hash"
        } as TResult;
      }
      throw new Error(`unexpected channel ${channel}`);
    }
  });

  await bridge.files.upload(file, {
    onProgress(nextProgress) {
      progress.push(nextProgress);
    }
  });

  assert.equal(sentBody, file);
  assert.deepEqual(progress.slice(0, 2), [
    { loadedBytes: 2, ratio: 0.4, totalBytes: 5 },
    { loadedBytes: 5, ratio: 1, totalBytes: 5 }
  ]);
  assert.deepEqual(
    calls.map((call) => call.channel),
    [
      workspaceAppExternalChannels.filesUploadPrepare,
      workspaceAppExternalChannels.filesUploadComplete
    ]
  );
});

test("workspace app external bridge ignores throwing upload progress listeners", async () => {
  const calls: Array<{ channel: string; payload?: unknown }> = [];
  const file = new Blob(["hello"], { type: "text/plain" }) as File;
  Object.defineProperty(file, "name", { value: "note.txt" });
  const bridge = createWorkspaceAppExternalBridge({
    appContext: {
      async get() {
        return { locale: "en" };
      },
      subscribe() {
        throw new Error("unexpected subscribe");
      }
    },
    createXMLHttpRequest() {
      return {
        onabort: null,
        onerror: null,
        onload: null,
        status: 0,
        upload: { onprogress: null },
        abort() {
          this.onabort?.();
        },
        open() {
          return undefined;
        },
        send() {
          this.upload?.onprogress?.({ loaded: 2, total: 5 });
          this.status = 204;
          this.onload?.();
        },
        setRequestHeader() {
          return undefined;
        }
      };
    },
    isUserActivationActive: () => false,
    send: unexpectedSend,
    async invoke<TResult>(channel: string, payload?: unknown) {
      calls.push({ channel, payload });
      if (channel === workspaceAppExternalChannels.filesUploadPrepare) {
        return {
          expiresAt: "2026-06-24T12:15:00Z",
          headers: {
            Authorization: "Bearer app-token",
            "Content-Type": "application/octet-stream"
          },
          method: "PUT",
          uploadId: "upload-1",
          url: "http://127.0.0.1:4545/v1/workspaces/ws-1/apps/canvas/uploads/upload-1/content"
        } as TResult;
      }
      if (channel === workspaceAppExternalChannels.filesUploadComplete) {
        return {
          path: "/state/apps/installations/canvas/data/uploads/2c/hash.txt",
          name: "note.txt",
          mimeType: "text/plain",
          sizeBytes: 5,
          sha256: "hash"
        } as TResult;
      }
      throw new Error(`unexpected channel ${channel}`);
    }
  });

  await bridge.files.upload(file, {
    onProgress() {
      throw new Error("progress failed");
    }
  });

  assert.deepEqual(
    calls.map((call) => call.channel),
    [
      workspaceAppExternalChannels.filesUploadPrepare,
      workspaceAppExternalChannels.filesUploadComplete
    ]
  );
});

test("workspace app external bridge cancels upload with abort signal", async () => {
  const calls: Array<{ channel: string; payload?: unknown }> = [];
  const controller = new AbortController();
  let aborted = false;
  let sentBody: unknown;
  const file = new Blob(["hello"], { type: "text/plain" }) as File;
  Object.defineProperty(file, "name", { value: "note.txt" });
  const bridge = createWorkspaceAppExternalBridge({
    appContext: {
      async get() {
        return { locale: "en" };
      },
      subscribe() {
        throw new Error("unexpected subscribe");
      }
    },
    createXMLHttpRequest() {
      return {
        onabort: null,
        onerror: null,
        onload: null,
        status: 0,
        upload: { onprogress: null },
        abort() {
          aborted = true;
          this.onabort?.();
        },
        open() {
          return undefined;
        },
        send(body: Blob | File) {
          sentBody = body;
        },
        setRequestHeader() {
          return undefined;
        }
      };
    },
    isUserActivationActive: () => false,
    send: unexpectedSend,
    async invoke<TResult>(channel: string, payload?: unknown) {
      calls.push({ channel, payload });
      if (channel === workspaceAppExternalChannels.filesUploadPrepare) {
        return {
          expiresAt: "2026-06-24T12:15:00Z",
          headers: {
            Authorization: "Bearer app-token",
            "Content-Type": "application/octet-stream"
          },
          method: "PUT",
          uploadId: "upload-1",
          url: "http://127.0.0.1:4545/v1/workspaces/ws-1/apps/canvas/uploads/upload-1/content"
        } as TResult;
      }
      if (channel === workspaceAppExternalChannels.filesUploadCancel) {
        return undefined as TResult;
      }
      throw new Error(`unexpected channel ${channel}`);
    }
  });

  const uploadPromise = bridge.files.upload(file, {
    onProgress() {
      return undefined;
    },
    signal: controller.signal
  });
  await Promise.resolve();
  await Promise.resolve();
  controller.abort();

  await assert.rejects(uploadPromise, (error: unknown) => {
    return (
      typeof error === "object" &&
      error !== null &&
      "name" in error &&
      error.name === "AbortError"
    );
  });
  assert.equal(sentBody, file);
  assert.equal(aborted, true);
  assert.deepEqual(calls, [
    {
      channel: workspaceAppExternalChannels.filesUploadPrepare,
      payload: {
        purpose: "app-asset",
        name: "note.txt",
        mimeType: "text/plain",
        sizeBytes: 5
      }
    },
    {
      channel: workspaceAppExternalChannels.filesUploadCancel,
      payload: { uploadId: "upload-1" }
    }
  ]);
});

test("workspace app external bridge cancels when aborted during complete", async () => {
  const calls: Array<{ channel: string; payload?: unknown }> = [];
  const controller = new AbortController();
  let releaseComplete!: () => void;
  let markCompleteStarted!: () => void;
  const completeStarted = new Promise<void>((resolve) => {
    markCompleteStarted = resolve;
  });
  const completeRelease = new Promise<void>((resolve) => {
    releaseComplete = resolve;
  });
  const file = new Blob(["hello"], { type: "text/plain" }) as File;
  Object.defineProperty(file, "name", { value: "note.txt" });
  const bridge = createWorkspaceAppExternalBridge({
    appContext: {
      async get() {
        return { locale: "en" };
      },
      subscribe() {
        throw new Error("unexpected subscribe");
      }
    },
    async fetch() {
      return new Response(null, { status: 204 });
    },
    isUserActivationActive: () => false,
    send: unexpectedSend,
    async invoke<TResult>(channel: string, payload?: unknown) {
      calls.push({ channel, payload });
      if (channel === workspaceAppExternalChannels.filesUploadPrepare) {
        return {
          expiresAt: "2026-06-24T12:15:00Z",
          headers: {
            Authorization: "Bearer app-token",
            "Content-Type": "application/octet-stream"
          },
          method: "PUT",
          uploadId: "upload-1",
          url: "http://127.0.0.1:4545/v1/workspaces/ws-1/apps/canvas/uploads/upload-1/content"
        } as TResult;
      }
      if (channel === workspaceAppExternalChannels.filesUploadComplete) {
        markCompleteStarted();
        await completeRelease;
        return {
          path: "/state/apps/installations/canvas/data/uploads/2c/hash.txt",
          name: "note.txt",
          mimeType: "text/plain",
          sizeBytes: 5,
          sha256: "hash"
        } as TResult;
      }
      if (channel === workspaceAppExternalChannels.filesUploadCancel) {
        return undefined as TResult;
      }
      throw new Error(`unexpected channel ${channel}`);
    }
  });

  const uploadPromise = bridge.files.upload(file, {
    signal: controller.signal
  });
  await completeStarted;
  controller.abort();
  releaseComplete();

  await assert.rejects(uploadPromise, (error: unknown) => {
    return (
      typeof error === "object" &&
      error !== null &&
      "name" in error &&
      error.name === "AbortError"
    );
  });
  assert.deepEqual(
    calls.map((call) => call.channel),
    [
      workspaceAppExternalChannels.filesUploadPrepare,
      workspaceAppExternalChannels.filesUploadComplete,
      workspaceAppExternalChannels.filesUploadCancel
    ]
  );
});

test("workspace app external bridge invokes PDF print with activation", async () => {
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
    send: unexpectedSend,
    async invoke<TResult>(channel: string, payload?: unknown) {
      calls.push({ channel, payload });
      return { bytes: new Uint8Array([37, 80, 68, 70]) } as TResult;
    }
  });

  assert.deepEqual(
    await bridge.pdf.printHtmlToPdf({ html: "<h1>Hello</h1>" }),
    {
      bytes: new Uint8Array([37, 80, 68, 70])
    }
  );
  assert.deepEqual(calls, [
    {
      channel: workspaceAppExternalChannels.pdfPrintHtml,
      payload: { html: "<h1>Hello</h1>" }
    }
  ]);
});

test("workspace app external bridge requires activation for PDF print", () => {
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
    send: unexpectedSend,
    async invoke() {
      throw new Error("unexpected invoke");
    }
  });

  assert.throws(
    () => bridge.pdf.printHtmlToPdf({ html: "<h1>Hello</h1>" }),
    /pdf\.printHtmlToPdf requires a user action/
  );
});

test("workspace app external bridge requires activation for permission request", () => {
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
    send: unexpectedSend,
    async invoke() {
      throw new Error("unexpected invoke");
    }
  });

  assert.throws(
    () =>
      bridge.permissions.request({
        nonce: "nonce-1",
        permission: "managed-ai-models",
        scopes: ["model:invoke"],
        state: "state-1"
      }),
    /permissions\.request requires a user action/
  );
});

test("workspace app external bridge invokes permission request with activation", async () => {
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
    send: unexpectedSend,
    async invoke<TResult>(channel: string, payload?: unknown) {
      calls.push({ channel, payload });
      return {
        code: "grant-code-1",
        contextToken: "context-token-1"
      } as TResult;
    }
  });

  assert.deepEqual(
    await bridge.permissions.request({
      nonce: "nonce-1",
      permission: "managed-ai-models",
      providers: ["openai"],
      scopes: ["model:invoke"],
      state: "state-1"
    }),
    { code: "grant-code-1", contextToken: "context-token-1" }
  );
  assert.deepEqual(calls, [
    {
      channel: workspaceAppExternalChannels.permissionsRequest,
      payload: {
        nonce: "nonce-1",
        permission: "managed-ai-models",
        providers: ["openai"],
        scopes: ["model:invoke"],
        state: "state-1"
      }
    }
  ]);
});

test("workspace app external bridge requires activation for settings open", () => {
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
    send: unexpectedSend,
    async invoke() {
      throw new Error("unexpected invoke");
    }
  });

  assert.throws(
    () => bridge.settings.open({ tab: "models" }),
    /settings\.open requires a user action/
  );
});

test("workspace app external bridge invokes settings open with activation", async () => {
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
    send: unexpectedSend,
    async invoke<TResult>(channel: string, payload?: unknown) {
      calls.push({ channel, payload });
      return undefined as TResult;
    }
  });

  await bridge.settings.open({ provider: "openai", tab: "models" });
  assert.deepEqual(calls, [
    {
      channel: workspaceAppExternalChannels.settingsOpen,
      payload: { provider: "openai", tab: "models" }
    }
  ]);
});

test("workspace app external bridge invokes user project list without activation", async () => {
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
    send: unexpectedSend,
    async invoke<TResult>(channel: string, payload?: unknown) {
      calls.push({ channel, payload });
      return {
        projects: [
          {
            id: "repo",
            label: "repo",
            path: "/workspace/repo",
            pinnedAtUnixMs: 0
          }
        ]
      } as TResult;
    }
  });

  assert.deepEqual(await bridge.userProjects.list(), {
    projects: [
      {
        id: "repo",
        label: "repo",
        path: "/workspace/repo",
        pinnedAtUnixMs: 0
      }
    ]
  });
  assert.equal("pin" in bridge.userProjects, false);
  assert.deepEqual(calls, [
    {
      channel: workspaceAppExternalChannels.userProjectsList,
      payload: undefined
    }
  ]);
});

test("workspace app external bridge invokes user project move without activation", async () => {
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
    send: unexpectedSend,
    async invoke<TResult>(channel: string, payload?: unknown) {
      calls.push({ channel, payload });
      return undefined as TResult;
    }
  });

  await bridge.userProjects.move({
    beforeProjectId: null,
    projectId: "project-alpha"
  });
  assert.deepEqual(calls, [
    {
      channel: workspaceAppExternalChannels.userProjectsMove,
      payload: { beforeProjectId: null, projectId: "project-alpha" }
    }
  ]);
});

test("workspace app external bridge invokes user project snapshot reads without activation", async () => {
  const calls: Array<{ channel: string; payload?: unknown }> = [];
  const snapshot = {
    error: null,
    initialized: true,
    isLoading: false,
    projects: [
      {
        id: "repo",
        label: "repo",
        path: "/workspace/repo",
        pinnedAtUnixMs: 0
      }
    ],
    revision: 3
  };
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
    send: unexpectedSend,
    async invoke<TResult>(channel: string, payload?: unknown) {
      calls.push({ channel, payload });
      return snapshot as TResult;
    }
  });

  assert.deepEqual(await bridge.userProjects.getSnapshot(), snapshot);
  assert.deepEqual(await bridge.userProjects.refresh(), snapshot);
  assert.deepEqual(calls, [
    {
      channel: workspaceAppExternalChannels.userProjectsGetSnapshot,
      payload: undefined
    },
    {
      channel: workspaceAppExternalChannels.userProjectsRefresh,
      payload: undefined
    }
  ]);
});

test("workspace app external bridge subscribes to user project snapshots", () => {
  const snapshot = {
    error: null,
    initialized: true,
    isLoading: false,
    projects: [
      {
        id: "repo",
        label: "repo",
        path: "/workspace/repo",
        pinnedAtUnixMs: 0
      }
    ],
    revision: 3
  };
  const snapshots: unknown[] = [];
  let didUnsubscribe = false;
  const bridge = createWorkspaceAppExternalBridge({
    appContext: {
      async get() {
        return { locale: "en" };
      },
      subscribe() {
        throw new Error("unexpected app subscribe");
      }
    },
    isUserActivationActive: () => false,
    send: unexpectedSend,
    subscribeToUserProjects(listener) {
      listener(snapshot);
      return () => {
        didUnsubscribe = true;
      };
    },
    async invoke() {
      throw new Error("unexpected invoke");
    }
  });

  const unsubscribe = bridge.userProjects.subscribe((nextSnapshot) => {
    snapshots.push(nextSnapshot);
  });
  unsubscribe();

  assert.deepEqual(snapshots, [snapshot]);
  assert.equal(didUnsubscribe, true);
});

test("workspace app external bridge invokes user project use without activation", async () => {
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
    send: unexpectedSend,
    async invoke<TResult>(channel: string, payload?: unknown) {
      calls.push({ channel, payload });
      return { id: "repo", label: "repo", path: "/workspace/repo" } as TResult;
    }
  });

  assert.deepEqual(await bridge.userProjects.use({ path: "/workspace/repo" }), {
    id: "repo",
    label: "repo",
    path: "/workspace/repo"
  });
  assert.deepEqual(calls, [
    {
      channel: workspaceAppExternalChannels.userProjectsUse,
      payload: { path: "/workspace/repo" }
    }
  ]);
});

test("workspace app external bridge requires activation for user project create", () => {
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
    send: unexpectedSend,
    async invoke() {
      throw new Error("unexpected invoke");
    }
  });

  assert.throws(
    () => bridge.userProjects.create({ name: "repo" }),
    /userProjects\.create requires a user action/
  );
});

test("workspace app external bridge requires activation for user project directory select", () => {
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
    send: unexpectedSend,
    async invoke() {
      throw new Error("unexpected invoke");
    }
  });

  assert.throws(
    () => bridge.userProjects.selectDirectory(),
    /userProjects\.selectDirectory requires a user action/
  );
});

test("workspace app external bridge sends logs without user activation", () => {
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
    send(channel, payload) {
      calls.push({ channel, payload });
    },
    async invoke() {
      throw new Error("unexpected invoke");
    }
  });

  bridge.logs.write({
    event: "page.loaded",
    level: "info",
    details: { route: "/home" }
  });

  assert.deepEqual(calls, [
    {
      channel: workspaceAppExternalChannels.logsWrite,
      payload: {
        event: "page.loaded",
        level: "info",
        details: { route: "/home" }
      }
    }
  ]);
});

test("workspace app external bridge ignores invalid log payloads", () => {
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
    send(channel, payload) {
      calls.push({ channel, payload });
    },
    async invoke() {
      throw new Error("unexpected invoke");
    }
  });

  assert.doesNotThrow(() => bridge.logs.write({ event: "" } as never));
  assert.deepEqual(calls, []);
});

test("requireUserActivation throws only when inactive", () => {
  assert.doesNotThrow(() => requireUserActivation(true, "files.select"));
  assert.throws(
    () => requireUserActivation(false, "files.select"),
    /files\.select requires a user action/
  );
});
