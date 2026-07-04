import assert from "node:assert/strict";
import test from "node:test";
import { createDesktopAgentActivityRuntime } from "./createDesktopAgentActivityRuntime.ts";
import type { IWorkspaceAgentActivityService } from "./workspaceAgentActivityService.interface.ts";

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

test("desktop agent activity runtime hides prompt uploads without archive support", () => {
  const runtime = createDesktopAgentActivityRuntime(
    createWorkspaceAgentActivityService()
  );

  assert.equal(runtime.promptContentUploadSupport?.file, false);
  assert.equal(runtime.uploadPromptContent, undefined);
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

function createWorkspaceAgentActivityService(): IWorkspaceAgentActivityService {
  return {
    _serviceBrand: undefined,
    activateSession: async () => {
      throw new Error("not implemented");
    },
    cancelSession: async () => {
      throw new Error("not implemented");
    },
    createSession: async () => {
      throw new Error("not implemented");
    },
    deleteSession: async () => {
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
    getSessionControlState: async () => {
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
      sections: [],
      workspaceId: "workspace-1"
    }),
    listSessionSectionPage: async (input) => ({
      kind: "conversations",
      sectionKey: input.sectionKey,
      sessions: [],
      hasMore: false
    }),
    scanExternalSessionImports: async () => {
      throw new Error("not implemented");
    },
    importExternalSessions: async () => {
      throw new Error("not implemented");
    },
    load: async () => {
      throw new Error("not implemented");
    },
    onSessionEvent: () => () => {},
    submitInteractive: async () => {
      throw new Error("not implemented");
    },
    submitPlanDecision: async () => {
      throw new Error("not implemented");
    },
    ensureSessionSynchronized: () => () => {},
    retainSessionEvents: () => () => {},
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
