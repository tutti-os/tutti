import assert from "node:assert/strict";
import test from "node:test";
import { AGENT_CONVERSATION_RAIL_RUNTIME_METHODS } from "@tutti-os/agent-gui/conversation-rail-runtime";
import { createDesktopAgentActivityRuntime } from "./createDesktopAgentActivityRuntime.ts";
import type { IWorkspaceAgentActivityService } from "./workspaceAgentActivityService.interface.ts";

test("desktop agent activity runtime installs the complete conversation rail capability", () => {
  const runtime = createDesktopAgentActivityRuntime(
    createWorkspaceAgentActivityService()
  );

  for (const method of AGENT_CONVERSATION_RAIL_RUNTIME_METHODS) {
    assert.equal(typeof runtime[method], "function", method);
  }
});

test("desktop agent activity runtime scopes section query caches by workspace", () => {
  const runtime = createDesktopAgentActivityRuntime(
    createWorkspaceAgentActivityService()
  );

  const first = runtime.getSessionSectionsQueryCache?.("workspace-1");
  const same = runtime.getSessionSectionsQueryCache?.(" workspace-1 ");
  const other = runtime.getSessionSectionsQueryCache?.("workspace-2");

  assert.ok(first);
  assert.equal(first, same);
  assert.notEqual(first, other);
});

test("desktop agent activity runtime forwards package diagnostics to renderer diagnostics", () => {
  const rendererDiagnostics: unknown[] = [];
  const runtime = createDesktopAgentActivityRuntime(
    createWorkspaceAgentActivityService(),
    {
      runtimeApi: {
        async logRendererDiagnostic(payload) {
          rendererDiagnostics.push(payload);
        },
        async logTerminalDiagnostic() {}
      }
    }
  );

  runtime.reportDiagnostic?.({
    details: {
      phase: "submit_interactive"
    },
    event: "agent.gui.caught_error",
    level: "error",
    workspaceId: "workspace-1"
  });

  assert.deepEqual(rendererDiagnostics, [
    {
      details: {
        phase: "submit_interactive"
      },
      event: "agent.gui.caught_error",
      level: "error",
      source: "agent-gui",
      workspaceId: "workspace-1"
    }
  ]);
});

test("desktop agent activity runtime keeps successful message reads at debug", async () => {
  const rendererDiagnostics: Array<{ event: string; level?: string }> = [];
  const service = createWorkspaceAgentActivityService();
  service.listSessionMessages = async () => ({
    hasMore: false,
    latestVersion: 0,
    messages: []
  });
  const runtime = createDesktopAgentActivityRuntime(service, {
    runtimeApi: {
      async logRendererDiagnostic(payload) {
        rendererDiagnostics.push(payload);
      },
      async logTerminalDiagnostic() {}
    }
  });

  await runtime.listSessionMessages({
    agentSessionId: "session-1",
    workspaceId: "workspace-1"
  });

  assert.deepEqual(rendererDiagnostics, [
    {
      details: {
        afterVersion: null,
        agentSessionId: "session-1",
        beforeVersion: null,
        cache: null,
        hasMore: false,
        lastMessage: null,
        latestVersion: 0,
        messageCount: 0,
        order: null
      },
      event: "agent.gui.runtime.messages.resolved",
      level: "debug",
      source: "agent-gui",
      workspaceId: "workspace-1"
    }
  ]);
});

test("desktop agent activity runtime hides prompt uploads without archive support", () => {
  const runtime = createDesktopAgentActivityRuntime(
    createWorkspaceAgentActivityService()
  );

  assert.equal(runtime.promptContentUploadSupport?.file, false);
  assert.equal(runtime.promptContentUploadSupport?.image, false);
  assert.equal(runtime.uploadPromptContent, undefined);
  assert.equal(runtime.stagePastedText, undefined);
});

test("desktop agent activity runtime stages pasted text as a local prompt asset", async () => {
  const archiveInputs: unknown[] = [];
  const runtime = createDesktopAgentActivityRuntime(
    createWorkspaceAgentActivityService(),
    {
      hostFilesApi: {
        async archiveAgentPromptFile(input) {
          archiveInputs.push(input);
          return {
            name: input.displayName ?? "attachment",
            path: "/Users/local/Library/Application Support/Tutti/agent-prompt-assets/ws/pasted.txt",
            sizeBytes: 12
          };
        }
      }
    }
  );

  const result = await runtime.stagePastedText?.({
    workspaceId: "workspace-1",
    text: "hello 世界",
    name: "pasted-text.txt"
  });

  assert.deepEqual(archiveInputs, [
    {
      workspaceID: "workspace-1",
      dataBase64: "aGVsbG8g5LiW55WM",
      displayName: "pasted-text.txt",
      mimeType: "text/plain"
    }
  ]);
  assert.deepEqual(result, {
    name: "pasted-text.txt",
    path: "/Users/local/Library/Application Support/Tutti/agent-prompt-assets/ws/pasted.txt",
    sizeBytes: 12
  });
});

test("desktop agent activity runtime archives prompt file uploads", async () => {
  const archiveInputs: unknown[] = [];
  const runtime = createDesktopAgentActivityRuntime(
    createWorkspaceAgentActivityService(),
    {
      hostFilesApi: {
        async archiveAgentPromptFile(input) {
          archiveInputs.push(input);
          return {
            name: input.displayName ?? "attachment",
            path: "/Users/local/Library/Application Support/Tutti/agent-prompt-assets/ws/report.pdf",
            sizeBytes: 42
          };
        }
      }
    }
  );

  assert.equal(runtime.promptContentUploadSupport?.image, true);
  const result = await runtime.uploadPromptContent?.({
    workspaceId: "workspace-1",
    content: [
      {
        type: "file",
        hostPath: "/Users/local/Downloads/report.pdf",
        name: "report.pdf",
        kind: "file"
      }
    ]
  });

  assert.deepEqual(archiveInputs, [
    {
      workspaceID: "workspace-1",
      hostPath: "/Users/local/Downloads/report.pdf",
      displayName: "report.pdf",
      mimeType: null
    }
  ]);
  assert.deepEqual(result, {
    content: [
      {
        type: "file",
        hostPath: "/Users/local/Downloads/report.pdf",
        name: "report.pdf",
        kind: "file",
        path: "/Users/local/Library/Application Support/Tutti/agent-prompt-assets/ws/report.pdf",
        sizeBytes: 42,
        uploadStatus: "uploaded"
      }
    ]
  });
});

test("desktop agent activity runtime archives inline file data (pasted text)", async () => {
  const archiveInputs: unknown[] = [];
  const runtime = createDesktopAgentActivityRuntime(
    createWorkspaceAgentActivityService(),
    {
      hostFilesApi: {
        async archiveAgentPromptFile(input) {
          archiveInputs.push(input);
          return {
            name: input.displayName ?? "pasted-text.txt",
            path: "/Users/local/Library/Application Support/Tutti/agent-prompt-assets/ws/aa/deadbeef.txt",
            sizeBytes: 36
          };
        }
      }
    }
  );

  const result = await runtime.uploadPromptContent?.({
    workspaceId: "workspace-1",
    content: [
      {
        type: "file",
        data: "Zmlyc3QgcGFzdGVkIGxpbmUKc2Vjb25kIHBhc3RlZCBsaW5l",
        mimeType: "text/plain",
        name: "pasted-text.txt"
      }
    ]
  });

  // Inline bytes are archived via dataBase64 (no hostPath).
  assert.deepEqual(archiveInputs, [
    {
      workspaceID: "workspace-1",
      dataBase64: "Zmlyc3QgcGFzdGVkIGxpbmUKc2Vjb25kIHBhc3RlZCBsaW5l",
      displayName: "pasted-text.txt",
      mimeType: "text/plain"
    }
  ]);
  // The base64 payload is dropped from the returned block; path/size are filled.
  assert.deepEqual(result, {
    content: [
      {
        type: "file",
        mimeType: "text/plain",
        name: "pasted-text.txt",
        path: "/Users/local/Library/Application Support/Tutti/agent-prompt-assets/ws/aa/deadbeef.txt",
        sizeBytes: 36,
        uploadStatus: "uploaded"
      }
    ]
  });
});

test("desktop agent activity runtime rejects file uploads without hostPath or data", async () => {
  const runtime = createDesktopAgentActivityRuntime(
    createWorkspaceAgentActivityService(),
    {
      hostFilesApi: {
        async archiveAgentPromptFile() {
          throw new Error("should not archive");
        }
      }
    }
  );

  const uploadPromptContent = runtime.uploadPromptContent;
  assert.ok(uploadPromptContent);
  await assert.rejects(
    () =>
      uploadPromptContent({
        workspaceId: "workspace-1",
        content: [{ type: "file", name: "empty.txt" }]
      }),
    /requires hostPath or data/
  );
});

test("desktop agent activity runtime archives prompt image uploads", async () => {
  const archiveInputs: unknown[] = [];
  const runtime = createDesktopAgentActivityRuntime(
    createWorkspaceAgentActivityService(),
    {
      hostFilesApi: {
        async archiveAgentPromptFile(input) {
          archiveInputs.push(input);
          return {
            name: input.displayName ?? "image.png",
            path: "/Users/local/Library/Application Support/Tutti/agent-prompt-assets/ws/image.png",
            sizeBytes: 12
          };
        }
      }
    }
  );

  const result = await runtime.uploadPromptContent?.({
    workspaceId: "workspace-1",
    content: [
      {
        type: "image",
        mimeType: "image/png",
        data: "aW1hZ2U=",
        name: "image.png"
      }
    ]
  });

  assert.deepEqual(archiveInputs, [
    {
      workspaceID: "workspace-1",
      dataBase64: "aW1hZ2U=",
      displayName: "image.png",
      mimeType: "image/png"
    }
  ]);
  assert.deepEqual(result, {
    content: [
      {
        type: "image",
        mimeType: "image/png",
        name: "image.png",
        path: "/Users/local/Library/Application Support/Tutti/agent-prompt-assets/ws/image.png",
        sizeBytes: 12,
        uploadStatus: "uploaded"
      }
    ]
  });
});

test("desktop agent activity runtime reads archived prompt assets", async () => {
  const readInputs: string[] = [];
  const runtime = createDesktopAgentActivityRuntime(
    createWorkspaceAgentActivityService(),
    {
      hostFilesApi: {
        async readLocalPreviewFile(path) {
          readInputs.push(path);
          return new Uint8Array([105, 109, 97, 103, 101]);
        }
      }
    }
  );

  const result = await runtime.readPromptAsset?.({
    workspaceId: "workspace-1",
    agentSessionId: "session-1",
    mimeType: "image/png",
    name: "image.png",
    path: "/Users/local/Library/Application Support/Tutti/agent-prompt-assets/ws/image.png"
  });

  assert.deepEqual(readInputs, [
    "/Users/local/Library/Application Support/Tutti/agent-prompt-assets/ws/image.png"
  ]);
  assert.deepEqual(result, {
    data: "aW1hZ2U=",
    mimeType: "image/png",
    name: "image.png",
    path: "/Users/local/Library/Application Support/Tutti/agent-prompt-assets/ws/image.png"
  });
});

test("desktop agent activity runtime delegates canonical session synchronization only", () => {
  const calls: unknown[] = [];
  const runtime = createDesktopAgentActivityRuntime({
    ...createWorkspaceAgentActivityService(),
    ensureSessionSynchronized(input) {
      calls.push(input);
      return () => {
        calls.push("dispose");
      };
    }
  });

  const dispose = runtime.ensureSessionSynchronized?.({
    workspaceId: "workspace-1",
    agentSessionId: "session-1",
    afterVersion: 42
  });
  dispose?.();

  assert.deepEqual(calls, [
    {
      workspaceId: "workspace-1",
      agentSessionId: "session-1",
      afterVersion: 42
    },
    "dispose"
  ]);
  assert.equal(
    (runtime as { retainSessionEvents?: unknown }).retainSessionEvents,
    undefined
  );
});

function createWorkspaceAgentActivityService(): IWorkspaceAgentActivityService {
  return {
    _serviceBrand: undefined,
    getSessionEngine() {
      throw new Error("not implemented");
    },
    activateSession: async () => {
      throw new Error("not implemented");
    },
    goalControl: async () => {
      throw new Error("not implemented");
    },
    createSession: async () => {
      throw new Error("not implemented");
    },
    deleteSession: async () => {
      throw new Error("not implemented");
    },
    renameSession: async () => {
      throw new Error("not implemented");
    },
    getSession: async () => {
      throw new Error("not implemented");
    },
    getComposerOptions: async () => {
      throw new Error("not implemented");
    },
    updateSessionSettings: async () => {
      throw new Error("not implemented");
    },
    updateTuttiModeActivation: async () => {
      throw new Error("not implemented");
    },
    getSnapshot: () => {
      throw new Error("not implemented");
    },
    listSessionMessages: async () => {
      throw new Error("not implemented");
    },
    listAgentGeneratedFiles: async () => {
      throw new Error("not implemented");
    },
    listSessionsPage: async () => ({
      hasMore: false,
      sessions: [],
      workspaceId: "workspace-1"
    }),
    listSessionSections: async () => ({
      pinned: { hasMore: false, sessions: [], totalCount: 0 },
      sections: [],
      workspaceId: "workspace-1"
    }),
    listSessionSectionPage: async (input) => ({
      kind: "conversations",
      sectionKey: input.sectionKey,
      sessions: [],
      hasMore: false,
      totalCount: 0
    }),
    listSessionSectionDeletionCandidates: async (input) => ({
      excludePinned: input.excludePinned ?? false,
      sectionKey: input.sectionKey,
      sessionIds: [],
      workspaceId: input.workspaceId
    }),
    deleteSessionsBatch: async () => ({
      cleanupFailedSessionIds: [],
      removedMessages: 0,
      removedSessionIds: [],
      removedSessions: 0
    }),
    listPinnedSessionsPage: async () => ({
      hasMore: false,
      sessions: [],
      totalCount: 0
    }),
    scanExternalSessionImports: async () => {
      throw new Error("not implemented");
    },
    importExternalSessions: async () => {
      throw new Error("not implemented");
    },
    selectExternalSessionImportArchive: async () => null,
    load: async () => {
      throw new Error("not implemented");
    },
    onSessionEvent: () => () => {},
    onModelCatalogInvalidated: () => () => {},
    onComposerDefaultsInvalidated: () => () => {},
    submitInteractive: async () => {
      throw new Error("not implemented");
    },
    submitPlanDecision: async () => {
      throw new Error("not implemented");
    },
    ensureSessionSynchronized: () => () => {},
    sendInput: async () => {
      throw new Error("not implemented");
    },
    readSessionAttachment: async () => {
      throw new Error("not implemented");
    },
    setSessionPinned: async () => {
      throw new Error("not implemented");
    },
    subscribe: () => () => {},
    unactivateSession: async () => {
      throw new Error("not implemented");
    }
  };
}
