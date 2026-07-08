import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultWorkspaceUserProjectI18nRuntime } from "@tutti-os/workspace-user-project/i18n";
import type { IssueManagerFeature } from "../../../../core/index.ts";
import {
  resolveIssueManagerAgentTargetOptions,
  resolveIssueManagerControllerCapabilities
} from "./IssueManagerControllerCapabilities.ts";

test("controller capabilities detect reference, upload, and invite support from the feature seam", () => {
  const capabilities = resolveIssueManagerControllerCapabilities(
    createFeature({
      fileAdapter: {
        listDirectory: async () => ({
          directoryPath: "/",
          entries: []
        }),
        requestUpload: async () => []
      },
      shareAdapter: {
        createIssueLink: async () => "https://example.com"
      },
      ui: {
        showInviteCollaborator: true
      }
    })
  );

  assert.deepEqual(capabilities, {
    canOpenAgentSessions: false,
    canInviteCollaborators: true,
    canReferenceWorkspaceFiles: true,
    canSelectExecutionDirectory: false,
    canUploadWorkspaceFiles: true
  });
});

test("controller capabilities disable invite and file support when adapters are missing", () => {
  const capabilities = resolveIssueManagerControllerCapabilities(
    createFeature({
      fileAdapter: undefined,
      shareAdapter: undefined,
      ui: {
        showInviteCollaborator: false
      }
    })
  );

  assert.deepEqual(capabilities, {
    canOpenAgentSessions: false,
    canInviteCollaborators: false,
    canReferenceWorkspaceFiles: false,
    canSelectExecutionDirectory: false,
    canUploadWorkspaceFiles: false
  });
});

test("controller capabilities detect execution directory support from the project service", () => {
  assert.equal(
    resolveIssueManagerControllerCapabilities(
      createFeature({
        executionDirectoryPicker: {
          selectDirectory: async () => null
        },
        fileAdapter: undefined,
        shareAdapter: undefined,
        ui: {
          showInviteCollaborator: false
        }
      })
    ).canSelectExecutionDirectory,
    false
  );

  assert.equal(
    resolveIssueManagerControllerCapabilities(
      createFeature({
        executionDirectoryPicker: {
          service: {} as NonNullable<
            NonNullable<
              IssueManagerFeature["executionDirectoryPicker"]
            >["service"]
          >
        },
        fileAdapter: undefined,
        shareAdapter: undefined,
        ui: {
          showInviteCollaborator: false
        }
      })
    ).canSelectExecutionDirectory,
    true
  );
});

test("agent target options are empty when no host adapter is configured", () => {
  assert.deepEqual(
    resolveIssueManagerAgentTargetOptions(
      createFeature({
        fileAdapter: undefined,
        shareAdapter: undefined,
        ui: {
          showInviteCollaborator: false
        }
      })
    ),
    []
  );
});

test("controller capabilities detect agent session opener support", () => {
  const capabilities = resolveIssueManagerControllerCapabilities({
    ...createFeature({
      fileAdapter: undefined,
      shareAdapter: undefined,
      ui: {
        showInviteCollaborator: false
      }
    }),
    agentSessionOpener: {
      openSession() {}
    }
  });

  assert.equal(capabilities.canOpenAgentSessions, true);
});

test("agent target options preserve an explicitly empty host list", () => {
  assert.deepEqual(
    resolveIssueManagerAgentTargetOptions({
      ...createFeature({
        fileAdapter: undefined,
        shareAdapter: undefined,
        ui: {
          showInviteCollaborator: false
        }
      }),
      agentTargetOptions: {
        getOptions: () => []
      }
    }),
    []
  );
});

test("agent target options trim labels and providers from the host adapter", () => {
  assert.deepEqual(
    resolveIssueManagerAgentTargetOptions({
      ...createFeature({
        fileAdapter: undefined,
        shareAdapter: undefined,
        ui: {
          showInviteCollaborator: false
        }
      }),
      agentTargetOptions: {
        getOptions: () => [
          {
            agentTargetId: " local:claude-code ",
            iconUrl: " claude.png ",
            label: "  Claude Code ",
            provider: " claude-code "
          },
          {
            agentTargetId: " local:gemini ",
            label: "   ",
            provider: " gemini "
          },
          { agentTargetId: "   ", label: "missing target", provider: " codex " }
        ]
      }
    }),
    [
      {
        agentTargetId: "local:claude-code",
        iconUrl: "claude.png",
        label: "Claude Code",
        provider: "claude-code"
      },
      {
        agentTargetId: "local:gemini",
        label: "gemini",
        provider: "gemini"
      }
    ]
  );
});

function createFeature(
  overrides: Pick<IssueManagerFeature, "fileAdapter" | "shareAdapter" | "ui"> &
    Pick<Partial<IssueManagerFeature>, "executionDirectoryPicker">
): IssueManagerFeature {
  return {
    agentRunner: {} as IssueManagerFeature["agentRunner"],
    backend: {} as IssueManagerFeature["backend"],
    executionDirectoryPicker: overrides.executionDirectoryPicker,
    fileAdapter: overrides.fileAdapter,
    i18n: {} as IssueManagerFeature["i18n"],
    identityAdapter: {} as IssueManagerFeature["identityAdapter"],
    shareAdapter: overrides.shareAdapter,
    workspaceUserProjectI18n: createDefaultWorkspaceUserProjectI18nRuntime(),
    ui: overrides.ui
  };
}
