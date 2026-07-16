import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultIssueManagerNodeFrame,
  defaultIssueManagerWorkbenchTypeId
} from "@tutti-os/workspace-issue-manager/workbench/constants";
import {
  workspaceImageFileNodeTypeID,
  workspaceTextFileNodeTypeID
} from "../workspaceFilePreviewLaunch.ts";
import { defaultWorkspaceTerminalWorkbenchTypeId } from "./workspaceTerminalWorkbenchConstants.ts";
import {
  createWorkspaceAgentGuiDraftLaunchRequest,
  createWorkspaceAgentGuiLaunchDescriptor,
  createWorkspaceAgentGuiSessionLaunchRequest,
  createWorkspaceAgentGuiInstanceId,
  createWorkspaceFilesDockEntry,
  toWorkspaceFilesActivation,
  workspaceAgentGuiNodeID,
  workspaceAgentGuiNodeFrame,
  workspaceAgentGuiProviderFromLaunchRequest,
  workspaceBrowserNodeID,
  workspaceFilePreviewNodeFrame,
  workspaceFilesNodeFrame,
  workspaceFilesNodeID
} from "./workspaceWorkbenchComposition.ts";

test("desktop workbench keeps its current stable node type identities", () => {
  assert.deepEqual(
    {
      agentGui: workspaceAgentGuiNodeID,
      browser: workspaceBrowserNodeID,
      files: workspaceFilesNodeID,
      imagePreview: workspaceImageFileNodeTypeID,
      issueManager: defaultIssueManagerWorkbenchTypeId,
      terminal: defaultWorkspaceTerminalWorkbenchTypeId,
      textPreview: workspaceTextFileNodeTypeID
    },
    {
      agentGui: "agent-gui",
      browser: "browser",
      files: "workspace-files",
      imagePreview: "workspace-image-file",
      issueManager: "issue-manager",
      terminal: "workspace-terminal",
      textPreview: "workspace-text-file"
    }
  );
});

test("createWorkspaceFilesDockEntry configures the files dock entry", () => {
  const entry = createWorkspaceFilesDockEntry({
    filesLabel: "Files",
    icon: null
  });

  assert.equal(entry.id, workspaceFilesNodeID);
  assert.equal(entry.label, "Files");
  assert.equal(entry.order, 10);
  assert.equal(entry.visibility, "always");
  assert.equal(
    entry.matchNode?.({
      data: {
        typeId: workspaceFilesNodeID
      }
    } as never),
    true
  );
});

test("workspace agent GUI creates opaque multi-open instance ids", () => {
  const first = createWorkspaceAgentGuiInstanceId();
  const second = createWorkspaceAgentGuiInstanceId();

  assert.notEqual(first, second);
  assert.match(first, /^agent-gui:instance:/);
  assert.match(second, /^agent-gui:instance:/);
});

test("workspace files open in the wide three-column frame", () => {
  assert.deepEqual(workspaceFilesNodeFrame, {
    height: 1200,
    width: 2520,
    x: 96,
    y: 28
  });
});

test("workspace file previews open at the task center default height", () => {
  assert.equal(
    workspaceFilePreviewNodeFrame.height,
    defaultIssueManagerNodeFrame.height
  );
});

test("workspace Agent GUI keeps its focused default size", () => {
  assert.deepEqual(workspaceAgentGuiNodeFrame, {
    height: defaultIssueManagerNodeFrame.height,
    width: 1040,
    x: 140,
    y: 48
  });
});

test("workspaceAgentGuiProviderFromLaunchRequest requires launch payload providers", () => {
  assert.equal(
    workspaceAgentGuiProviderFromLaunchRequest({
      dockEntryId: "agent-gui:codex",
      payload: { provider: "claude-code" },
      typeId: "agent-gui"
    }),
    "claude-code"
  );
  assert.throws(
    () =>
      workspaceAgentGuiProviderFromLaunchRequest({
        dockEntryId: "agent-gui:hermes",
        payload: {},
        typeId: "agent-gui"
      }),
    /agent_gui_workbench\.launch_provider_required/
  );
  assert.throws(
    () =>
      workspaceAgentGuiProviderFromLaunchRequest({
        payload: null,
        typeId: "agent-gui"
      }),
    /agent_gui_workbench\.launch_provider_required/
  );
});

test("workspace agent GUI session launches use container instances", () => {
  const descriptor = createWorkspaceAgentGuiLaunchDescriptor({
    dockEntryId: "agent-gui",
    payload: {
      agentSessionId: "session-2",
      provider: "codex"
    },
    typeId: "agent-gui"
  });

  assert.equal(descriptor.provider, "codex");
  assert.equal(descriptor.targetAgentSessionId, "session-2");
  assert.equal(descriptor.dockEntryId, "agent-gui:unified");
  assert.match(descriptor.instanceId, /^agent-gui:instance:/);
  assert.deepEqual(descriptor.reusePolicy, {
    agentSessionId: "session-2",
    kind: "current-session"
  });
  assert.deepEqual(descriptor.activation, {
    payload: {
      agentSessionId: "session-2"
    },
    type: "agent-gui:open-session"
  });
});

test("workspace agent GUI draft launches prefill prompts without binding sessions", () => {
  const descriptor = createWorkspaceAgentGuiLaunchDescriptor(
    createWorkspaceAgentGuiDraftLaunchRequest({
      draftPrompt: "Review this issue",
      provider: "codex",
      userProjectPath: "/workspace/app/"
    })
  );

  assert.equal(descriptor.provider, "codex");
  assert.equal(descriptor.targetAgentSessionId, null);
  assert.equal(descriptor.dockEntryId, "agent-gui:unified");
  assert.deepEqual(descriptor.reusePolicy, { kind: "none" });
  assert.deepEqual(descriptor.activation, {
    payload: {
      draftPrompt: "Review this issue",
      provider: "codex",
      userProjectPath: "/workspace/app"
    },
    type: "agent-gui:prefill-prompt"
  });
});

test("workspace agent GUI launch requests always use the unified dock entry", () => {
  const sessionRequest = createWorkspaceAgentGuiSessionLaunchRequest({
    agentSessionId: "session-2",
    provider: "claude-code"
  });
  const draftRequest = createWorkspaceAgentGuiDraftLaunchRequest({
    draftPrompt: "Review this issue",
    provider: "codex"
  });

  assert.equal(sessionRequest.dockEntryId, "agent-gui:unified");
  assert.equal(draftRequest.dockEntryId, "agent-gui:unified");
  assert.equal(
    createWorkspaceAgentGuiLaunchDescriptor(sessionRequest).dockEntryId,
    "agent-gui:unified"
  );
  assert.equal(
    createWorkspaceAgentGuiLaunchDescriptor(draftRequest).dockEntryId,
    "agent-gui:unified"
  );
  assert.equal(
    createWorkspaceAgentGuiLaunchDescriptor(sessionRequest).provider,
    "claude-code"
  );
});

test("toWorkspaceFilesActivation accepts reveal-file payloads and rejects others", () => {
  assert.deepEqual(
    toWorkspaceFilesActivation({
      payload: { path: "/workspace/docs/spec.md" },
      sequence: 1,
      type: "reveal-file"
    }),
    {
      payload: { path: "/workspace/docs/spec.md" },
      sequence: 1,
      type: "reveal-file"
    }
  );
  assert.equal(
    toWorkspaceFilesActivation({
      payload: { url: "https://example.com" },
      sequence: 2,
      type: "reveal-file"
    }),
    null
  );
  assert.equal(
    toWorkspaceFilesActivation({
      payload: { path: "/workspace/docs/spec.md" },
      sequence: 3,
      type: "open-browser"
    }),
    null
  );
});
