import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { defaultIssueManagerNodeFrame } from "@tutti-os/workspace-issue-manager/workbench/constants";
import {
  createWorkspaceAgentGuiDraftLaunchRequest,
  createWorkspaceAgentGuiLaunchDescriptor,
  createWorkspaceAgentGuiInstanceId,
  createWorkspaceFilesDockEntry,
  toWorkspaceFilesActivation,
  workspaceAgentGuiDockEntryId,
  workspaceAgentGuiInstanceId,
  workspaceAgentGuiNodeFrame,
  workspaceAgentGuiProviderFromIdentifier,
  workspaceAgentGuiProviderFromLaunchRequest,
  workspaceFilePreviewNodeFrame,
  workspaceFilesNodeFrame,
  workspaceFilesNodeID
} from "./workspaceWorkbenchComposition.ts";

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

test("workspace agent GUI identifiers keep codex as the legacy default entry", () => {
  assert.equal(workspaceAgentGuiDockEntryId("codex"), "agent-gui");
  assert.equal(
    workspaceAgentGuiDockEntryId("claude-code"),
    "agent-gui:claude-code"
  );
  assert.equal(workspaceAgentGuiInstanceId("codex"), "agent-gui:codex");
  assert.equal(workspaceAgentGuiInstanceId("gemini"), "agent-gui:gemini");
  assert.equal(workspaceAgentGuiProviderFromIdentifier("agent-gui"), "codex");
  assert.equal(
    workspaceAgentGuiProviderFromIdentifier("agent-gui:codex:panel:1"),
    "codex"
  );
  assert.equal(
    workspaceAgentGuiProviderFromIdentifier("agent-gui:openclaw"),
    "openclaw"
  );
  assert.equal(
    workspaceAgentGuiProviderFromIdentifier("agent-gui:unknown"),
    null
  );
});

test("workspace agent GUI creates multi-open panel instance ids", () => {
  const first = createWorkspaceAgentGuiInstanceId({ provider: "codex" });
  const second = createWorkspaceAgentGuiInstanceId({ provider: "codex" });

  assert.notEqual(first, second);
  assert.equal(workspaceAgentGuiProviderFromIdentifier(first), "codex");
  assert.equal(workspaceAgentGuiProviderFromIdentifier(second), "codex");
  assert.equal(
    createWorkspaceAgentGuiInstanceId({
      agentSessionId: "session:1",
      provider: "gemini"
    }),
    "agent-gui:gemini:session:session%3A1"
  );
});

test("workspace files open at the task center default height", () => {
  assert.equal(
    workspaceFilesNodeFrame.height,
    defaultIssueManagerNodeFrame.height
  );
});

test("workspace file previews open at the task center default height", () => {
  assert.equal(
    workspaceFilePreviewNodeFrame.height,
    defaultIssueManagerNodeFrame.height
  );
});

test("workspace file preview contribution uses the dialog popover layer", () => {
  const source = readFileSync(
    new URL("./workspaceFilePreviewContribution.ts", import.meta.url),
    "utf8"
  );

  assert.match(source, /surfaceLayer:\s*"dialog-popover"/);
});

test("workspace agent GUI opens at the files window default size", () => {
  assert.equal(workspaceAgentGuiNodeFrame.width, workspaceFilesNodeFrame.width);
  assert.equal(
    workspaceAgentGuiNodeFrame.height,
    workspaceFilesNodeFrame.height
  );
});

test("workspaceAgentGuiProviderFromLaunchRequest prefers launch payloads before dock identifiers", () => {
  assert.equal(
    workspaceAgentGuiProviderFromLaunchRequest({
      dockEntryId: "agent-gui:codex",
      payload: { provider: "claude-code" },
      typeId: "agent-gui"
    }),
    "claude-code"
  );
  assert.equal(
    workspaceAgentGuiProviderFromLaunchRequest({
      dockEntryId: "agent-gui:hermes",
      payload: {},
      typeId: "agent-gui"
    }),
    "hermes"
  );
  assert.equal(
    workspaceAgentGuiProviderFromLaunchRequest({
      payload: null,
      typeId: "agent-gui"
    }),
    "codex"
  );
});

test("workspace agent GUI session launches target exact session instances", () => {
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
  assert.equal(descriptor.dockEntryId, "agent-gui");
  assert.equal(descriptor.instanceId, "agent-gui:codex:session:session-2");
  assert.equal(descriptor.reuseDockEntryNode, false);
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
  assert.equal(descriptor.dockEntryId, "agent-gui");
  assert.equal(descriptor.reuseDockEntryNode, true);
  assert.deepEqual(descriptor.activation, {
    payload: {
      draftPrompt: "Review this issue",
      userProjectPath: "/workspace/app"
    },
    type: "agent-gui:prefill-prompt"
  });
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
