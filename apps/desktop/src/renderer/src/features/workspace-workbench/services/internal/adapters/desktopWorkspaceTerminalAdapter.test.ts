import assert from "node:assert/strict";
import test from "node:test";
import {
  TuttidProtocolError,
  type TuttidClient
} from "@tutti-os/client-tuttid-ts";
import type { DesktopHostFilesApi, DesktopRuntimeApi } from "@preload/types";
import type {
  DesktopTerminalDiagnosticPayload,
  DesktopTerminalStreamUrlRequest
} from "@shared/contracts/ipc";
import { createDesktopWorkspaceTerminalAdapter } from "./desktopWorkspaceTerminalAdapter.ts";

const workspaceId = "workspace-1";

test("desktop terminal adapter reloads session metadata before attach", async (t) => {
  const fakeWebSocket = installFakeWebSocket(t);
  const diagnostics: unknown[] = [];
  const adapter = createAdapter({
    runtimeApi: createRuntimeApi({
      diagnostics
    }),
    tuttidClient: createTuttidClient({
      async getWorkspaceTerminal(requestWorkspaceId, sessionId) {
        assert.equal(requestWorkspaceId, workspaceId);
        assert.equal(sessionId, "term-1");
        return createSession({
          cwd: "/Users/example/workspace",
          id: "term-1",
          title: "zsh"
        });
      }
    })
  });

  let stateChangeCount = 0;
  const unsubscribe = adapter.externalStateSource.subscribe(() => {
    stateChangeCount += 1;
  });

  await adapter.transport.attach({ afterSeq: 42, sessionId: "term-1" });

  const state = adapter.externalStateSource.get("term-1");
  assert.equal(state?.title, "zsh");
  assert.equal(state?.cwd, "/Users/example/workspace");
  assert.equal(state?.status, "running");
  assert.equal(stateChangeCount, 1);
  assert.equal(
    fakeWebSocket.instances[0]?.url,
    "ws://127.0.0.1:4000/v1/workspaces/workspace-1/terminals/term-1/ws?access_token=token-1&afterSeq=42"
  );
  assert.deepEqual(
    diagnostics.map((entry) => (entry as { event: string }).event),
    ["transport.attach.start", "transport.attach.open"]
  );

  unsubscribe();
});

test("desktop terminal adapter projects snapshot failures as failed terminal state", async (t) => {
  installFakeWebSocket(t);
  const diagnostics: unknown[] = [];
  const adapter = createAdapter({
    runtimeApi: createRuntimeApi({
      diagnostics
    }),
    tuttidClient: createTuttidClient({
      async getWorkspaceTerminalSnapshot() {
        throw new Error("snapshot missing");
      }
    })
  });

  await assert.rejects(
    () => adapter.transport.snapshot({ sessionId: "missing-term" }),
    /snapshot missing/
  );

  const state = adapter.externalStateSource.get("missing-term");
  assert.equal(state?.status, "failed");
  assert.equal(state?.lastError, "snapshot missing");
  assert.equal(state?.title, "Terminal");
  assert.deepEqual(
    diagnostics.map((entry) => (entry as { event: string }).event),
    ["transport.snapshot.start", "transport.snapshot.error"]
  );
});

test("desktop terminal adapter routes websocket frames and detach semantics", async (t) => {
  const fakeWebSocket = installFakeWebSocket(t);
  const diagnostics: unknown[] = [];
  const adapter = createAdapter({
    runtimeApi: createRuntimeApi({
      diagnostics
    })
  });
  const dataEvents: unknown[] = [];
  const stateEvents: unknown[] = [];
  const exitEvents: unknown[] = [];
  const metadataEvents: unknown[] = [];
  adapter.transport.onData((event) => dataEvents.push(event));
  adapter.transport.onState((event) => stateEvents.push(event));
  adapter.transport.onExit((event) => exitEvents.push(event));
  adapter.transport.onMetadata?.((event) => metadataEvents.push(event));

  await adapter.transport.attach({ sessionId: "term-1" });
  const socket = fakeWebSocket.instances[0];
  assert.ok(socket);

  socket.emit({
    data: "hello",
    seq: 7,
    sessionId: "term-1",
    type: "output"
  });
  socket.emit({
    cwd: "/Users/example/workspace",
    profileId: "shell-1",
    runtimeKind: "local",
    sessionId: "term-1",
    title: "zsh",
    type: "metadata"
  });
  socket.emit({
    fromSeq: 3,
    sessionId: "term-1",
    toSeq: 5,
    type: "gap"
  });
  socket.emit({
    sessionId: "term-1",
    status: "running",
    type: "state"
  });
  socket.emit({
    code: 0,
    sessionId: "term-1",
    signal: null,
    status: "exited",
    type: "exit"
  });

  await adapter.transport.write({ data: "pwd\n", sessionId: "term-1" });
  await adapter.transport.write({
    data: "\u0003",
    encoding: "binary",
    sessionId: "term-1"
  });
  await adapter.transport.detach({ sessionId: "term-1" });

  assert.deepEqual(dataEvents, [
    {
      data: "hello",
      seq: 7,
      sessionId: "term-1"
    }
  ]);
  assert.deepEqual(stateEvents, [
    {
      error: null,
      gapEndSeq: 5,
      gapStartSeq: 3,
      sessionId: "term-1",
      status: "running"
    },
    {
      error: null,
      gapEndSeq: null,
      gapStartSeq: null,
      sessionId: "term-1",
      status: "running"
    }
  ]);
  assert.deepEqual(metadataEvents, [
    {
      cwd: "/Users/example/workspace",
      profileId: "shell-1",
      runtimeKind: "local",
      sessionId: "term-1",
      title: "zsh"
    }
  ]);
  assert.deepEqual(exitEvents, [
    {
      code: 0,
      reason: null,
      sessionId: "term-1",
      signal: null
    }
  ]);
  assert.deepEqual(
    diagnostics.map((entry) => (entry as { event: string }).event),
    [
      "transport.attach.start",
      "transport.attach.open",
      "transport.frame.metadata",
      "transport.frame.gap",
      "transport.frame.state",
      "transport.frame.exit",
      "transport.attach.close"
    ]
  );
  const sentFrames = socket.sent.map((value) => JSON.parse(value) as unknown);
  assert.deepEqual(sentFrames, [
    {
      data: "pwd\n",
      type: "input"
    },
    {
      data: "Aw==",
      encoding: "binary",
      type: "input"
    },
    {
      type: "detach"
    }
  ]);
  assert.equal(socket.closeCount, 1);
});

test("desktop terminal adapter ignores stale detach calls from replaced clients", async (t) => {
  const fakeWebSocket = installFakeWebSocket(t);
  const adapter = createAdapter();

  await adapter.transport.attach({ clientId: "client-1", sessionId: "term-1" });
  const firstSocket = fakeWebSocket.instances[0];
  assert.ok(firstSocket);

  await adapter.transport.attach({ clientId: "client-2", sessionId: "term-1" });
  const secondSocket = fakeWebSocket.instances[1];
  assert.ok(secondSocket);
  assert.equal(firstSocket.closeCount, 1);

  await adapter.transport.detach({ clientId: "client-1", sessionId: "term-1" });

  assert.equal(secondSocket.closeCount, 0);

  await adapter.transport.write({ data: "pwd\n", sessionId: "term-1" });
  await adapter.transport.detach({ clientId: "client-2", sessionId: "term-1" });

  const sentFrames = secondSocket.sent.map(
    (value) => JSON.parse(value) as unknown
  );
  assert.deepEqual(sentFrames, [
    {
      data: "pwd\n",
      type: "input"
    },
    {
      type: "detach"
    }
  ]);
  assert.equal(secondSocket.closeCount, 1);
});

test("desktop terminal adapter projects current socket closes as detached state", async (t) => {
  const fakeWebSocket = installFakeWebSocket(t);
  const diagnostics: unknown[] = [];
  const adapter = createAdapter({
    runtimeApi: createRuntimeApi({
      diagnostics
    })
  });
  const stateEvents: unknown[] = [];
  adapter.transport.onState((event) => stateEvents.push(event));

  await adapter.transport.attach({ sessionId: "term-1" });
  const socket = fakeWebSocket.instances[0];
  assert.ok(socket);

  socket.close();

  assert.equal(adapter.externalStateSource.get("term-1")?.status, "detached");
  assert.deepEqual(stateEvents, [
    {
      error: null,
      gapEndSeq: null,
      gapStartSeq: null,
      sessionId: "term-1",
      status: "detached"
    }
  ]);
  assert.deepEqual(
    diagnostics.map((entry) => (entry as { event: string }).event),
    [
      "transport.attach.start",
      "transport.attach.open",
      "transport.attach.close"
    ]
  );
});

test("desktop terminal adapter keeps link and drop policies host-owned", async (t) => {
  installFakeWebSocket(t);
  const openedLinks: Array<{
    column?: number;
    cwd?: string | null;
    line?: number;
    path: string;
    workspaceID: string;
  }> = [];
  const openedUrls: string[] = [];
  const browserLaunchRequests: Array<{
    reuseIfOpen?: boolean;
    url: string;
    workspaceId: string;
  }> = [];

  const adapter = createAdapter({
    hostFilesApi: createHostFilesApi({
      async openExternal(url: string) {
        openedUrls.push(url);
      },
      async openTerminalLink(input) {
        openedLinks.push(input);
      }
    }),
    platformApi: {
      resolveDroppedPaths() {
        return ["/tmp/with space.txt", "/tmp/has ' quote.txt"];
      }
    },
    openBrowserUrl(request) {
      browserLaunchRequests.push(request);
      return true;
    }
  });

  await adapter.linkHandler.open({
    column: 4,
    cwd: "/Users/example/workspace",
    line: 12,
    path: "./src/index.ts"
  });
  await adapter.linkHandler.open({ url: "https://example.com" });

  const dropped = adapter.dropInput({
    cwd: "/tmp",
    dataTransfer: createDataTransfer({ text: "ignored" }),
    sessionId: "term-1"
  });

  assert.deepEqual(openedLinks, [
    {
      column: 4,
      cwd: "/Users/example/workspace",
      line: 12,
      path: "./src/index.ts",
      workspaceID: workspaceId
    }
  ]);
  assert.deepEqual(browserLaunchRequests, [
    {
      reuseIfOpen: true,
      source: "terminal",
      url: "https://example.com",
      workspaceId
    }
  ]);
  assert.deepEqual(openedUrls, []);
  assert.equal(dropped, "'/tmp/with space.txt' '/tmp/has '\\'' quote.txt' ");
});

test("desktop terminal adapter falls back to host external opener when browser launch is unavailable", async (t) => {
  installFakeWebSocket(t);
  const openedUrls: string[] = [];
  const adapter = createAdapter({
    hostFilesApi: createHostFilesApi({
      async openExternal(url: string) {
        openedUrls.push(url);
      }
    }),
    openBrowserUrl: () => false
  });

  await adapter.linkHandler.open({ url: "https://example.com/fallback" });

  assert.deepEqual(openedUrls, ["https://example.com/fallback"]);
});

test("desktop terminal adapter falls back to host external opener when browser launch fails", async (t) => {
  installFakeWebSocket(t);
  const openedUrls: string[] = [];
  const adapter = createAdapter({
    hostFilesApi: createHostFilesApi({
      async openExternal(url: string) {
        openedUrls.push(url);
      }
    }),
    async openBrowserUrl() {
      throw new Error("browser launch failed");
    }
  });

  await adapter.linkHandler.open({ url: "https://example.com/rejected" });

  assert.deepEqual(openedUrls, ["https://example.com/rejected"]);
});

test("desktop terminal adapter treats missing terminals as stale during close guard and resize", async (t) => {
  installFakeWebSocket(t);
  let resizeCalls = 0;
  const adapter = createAdapter({
    tuttidClient: createTuttidClient({
      async checkWorkspaceTerminalCloseGuard() {
        throw new TuttidProtocolError({
          code: "workspace_terminal_not_found",
          reason: "workspace_terminal_not_found",
          statusCode: 404
        });
      },
      async resizeWorkspaceTerminal() {
        resizeCalls += 1;
        throw new TuttidProtocolError({
          code: "workspace_terminal_not_found",
          reason: "workspace_terminal_not_found",
          statusCode: 404
        });
      }
    })
  });

  const guard = await adapter.closeGuard.check({ sessionId: "missing-term" });
  assert.deepEqual(guard, {
    leaderCommand: null,
    reason: "not-running",
    requiresConfirmation: false,
    status: "failed"
  });
  assert.equal(
    adapter.externalStateSource.get("missing-term")?.status,
    "failed"
  );

  await adapter.transport.resize({
    cols: 80,
    rows: 24,
    sessionId: "missing-term"
  });
  await adapter.transport.resize({
    cols: 100,
    rows: 30,
    sessionId: "missing-term"
  });

  assert.equal(resizeCalls, 0);
});

function createAdapter(
  overrides: Partial<
    Parameters<typeof createDesktopWorkspaceTerminalAdapter>[0]
  > = {}
) {
  return createDesktopWorkspaceTerminalAdapter({
    hostFilesApi: createHostFilesApi(),
    tuttidClient: createTuttidClient(),
    platformApi: {
      resolveDroppedPaths() {
        return [];
      }
    },
    runtimeApi: createRuntimeApi(),
    terminalTitle: "Terminal",
    workspaceId,
    ...overrides
  });
}

function createRuntimeApi(input?: {
  diagnostics?: unknown[];
}): DesktopRuntimeApi {
  return {
    async getBackendConfig() {
      return {
        accessToken: "token-1",
        baseUrl: "http://127.0.0.1:4000"
      };
    },
    async getBusinessEventStreamUrl() {
      return "ws://127.0.0.1:4000/v1/events/ws?access_token=token-1";
    },
    async listWorkspaceAgentProbes(probeInput) {
      return {
        capturedAtUnixMs: 1,
        providers: [],
        workspaceId: probeInput.workspaceId
      };
    },
    async getTerminalStreamUrl(inputRequest: DesktopTerminalStreamUrlRequest) {
      const url = new URL(
        `/v1/workspaces/${encodeURIComponent(inputRequest.workspaceId)}/terminals/${encodeURIComponent(inputRequest.sessionId)}/ws`,
        "http://127.0.0.1:4000"
      );
      url.protocol = "ws:";
      url.searchParams.set("access_token", "token-1");
      if (inputRequest.afterSeq !== undefined) {
        url.searchParams.set("afterSeq", String(inputRequest.afterSeq));
      }
      return url.toString();
    },
    async logRendererDiagnostic() {},
    async logTerminalDiagnostic(payload: DesktopTerminalDiagnosticPayload) {
      input?.diagnostics?.push(payload);
    }
  };
}

function createHostFilesApi(
  overrides: Partial<DesktopHostFilesApi> = {}
): DesktopHostFilesApi {
  return {
    async createUserDocumentsProjectDirectory(input) {
      return { path: `/Users/local/Documents/tutti/${input.name}` };
    },
    async openExternal() {},
    async openFile() {},
    async revealInFolder() {},
    async revealWorkspaceFile() {},
    async openTerminalLink() {},
    async readLocalFileText(path) {
      return { content: "", name: "", path };
    },
    async readLocalPreviewFile() {
      return new Uint8Array();
    },
    async archiveAgentPromptFile(input) {
      return {
        name: input.displayName ?? "attachment",
        path: "/Users/local/Library/Application Support/Tutti/agent-prompt-assets/ws/attachment",
        sizeBytes: 1
      };
    },
    async readPreviewFile() {
      return new Uint8Array();
    },
    async selectAppArchive() {
      return null;
    },
    async selectAppArchiveExportPath() {
      return null;
    },
    async selectAppIconImage() {
      return null;
    },
    async selectDirectory() {
      return null;
    },
    async selectUploadFiles() {
      return [];
    },
    async copyImageToClipboard() {},
    async copyFilesToClipboard() {},
    async listOpenWithApplications() {
      return [];
    },
    async openFileWithApplication() {},
    async openFileWithOtherApplication() {},
    async openFileInBrowser() {},
    async resolveWorkspaceFileFileUrl() {
      return "file:///tmp/example.html";
    },
    async resolveEntryIcon() {
      return null;
    },
    ...overrides
  };
}

function createTuttidClient(
  overrides: Partial<TuttidClient> = {}
): TuttidClient {
  return {
    async checkWorkspaceTerminalCloseGuard() {
      return {
        leaderCommand: "zsh",
        reason: "running",
        requiresConfirmation: true,
        status: "running"
      };
    },
    async createWorkspaceTerminal() {
      return createSession({ id: "created-term" });
    },
    async getWorkspaceTerminal(_workspaceId, sessionId) {
      return createSession({ id: sessionId });
    },
    async getWorkspaceTerminalSnapshot() {
      return {
        data: "",
        fromSeq: null,
        toSeq: 0,
        truncated: false,
        updatedAt: Date.now()
      };
    },
    async listWorkspaceTerminals() {
      return [];
    },
    async resizeWorkspaceTerminal(_workspaceId, sessionId, input) {
      return createSession({
        cols: input.cols,
        id: sessionId,
        rows: input.rows
      });
    },
    async terminateWorkspaceTerminal(_workspaceId, sessionId) {
      return createSession({
        endedAt: new Date().toISOString(),
        id: sessionId,
        status: "exited"
      });
    },
    ...overrides
  } as TuttidClient;
}

function createSession(
  overrides: Partial<
    Awaited<ReturnType<TuttidClient["createWorkspaceTerminal"]>>
  > = {}
): Awaited<ReturnType<TuttidClient["createWorkspaceTerminal"]>> {
  return {
    cols: 80,
    createdAt: new Date(0).toISOString(),
    cwd: "/workspace",
    endedAt: null,
    id: "term-1",
    lastError: null,
    profileId: null,
    rows: 24,
    runtimeKind: "local",
    status: "running",
    title: "zsh",
    updatedAt: new Date(0).toISOString(),
    workspaceId,
    ...overrides
  };
}

function createDataTransfer(input: { text?: string }): DataTransfer {
  return {
    files: [],
    getData(type: string) {
      return type === "text/plain" ? (input.text ?? "") : "";
    }
  } as unknown as DataTransfer;
}

function installFakeWebSocket(t: { after(callback: () => void): void }) {
  const originalWebSocket = globalThis.WebSocket;
  class FakeWebSocket extends EventTarget {
    static readonly CLOSED = 3;
    static readonly CLOSING = 2;
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static instances: FakeWebSocket[] = [];

    closeCount = 0;
    readyState = FakeWebSocket.CONNECTING;
    sent: string[] = [];
    url: string;

    constructor(url: string) {
      super();
      this.url = url;
      FakeWebSocket.instances.push(this);
      queueMicrotask(() => {
        this.readyState = FakeWebSocket.OPEN;
        this.dispatchEvent(new Event("open"));
      });
    }

    close() {
      this.closeCount += 1;
      this.readyState = FakeWebSocket.CLOSED;
      this.dispatchEvent(new Event("close"));
    }

    emit(frame: unknown) {
      this.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify(frame)
        })
      );
    }

    send(data: string) {
      this.sent.push(data);
    }
  }

  FakeWebSocket.instances = [];
  globalThis.WebSocket =
    FakeWebSocket as unknown as typeof globalThis.WebSocket;
  t.after(() => {
    globalThis.WebSocket = originalWebSocket;
  });
  return FakeWebSocket;
}
