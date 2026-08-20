import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSessionEngine } from "@tutti-os/agent-activity-core";
import type { AgentGUIRuntime } from "@tutti-os/agent-gui";
import { desktopAgentGUIOpenSessionActivationType } from "../desktopAgentGUINodeState.ts";
import { consumeDesktopAgentGUIOpenSessionActivation } from "./desktopAgentGUIOpenSessionActivation.ts";
import { clearDesktopAgentGUIOpenSessionComposerRequest } from "./desktopAgentGUIOpenSessionComposerActivation.ts";

test("source-session activation selects the exact session and requests a non-submitting composer append", () => {
  const selected: unknown[] = [];
  const composerRequests: unknown[] = [];
  const submissions: unknown[] = [];
  const runtime = {
    getSessionEngine() {
      return {
        activateSession(input: unknown) {
          selected.push(input);
          return true;
        },
        getSnapshot: () => ({ sessionLifecycle: { sessionsById: {} } })
      } as unknown as AgentSessionEngine;
    }
  } as Pick<AgentGUIRuntime, "getSessionEngine">;

  consumeDesktopAgentGUIOpenSessionActivation({
    activation: {
      payload: {
        agentSessionId: " source-session-9 ",
        composerAppend: {
          draftPrompt:
            "Please modify [Managed workflow](mention://workspace-issue/issue-managed?workspaceId=workspace-1)",
          focusComposer: true
        }
      },
      sequence: 19,
      type: desktopAgentGUIOpenSessionActivationType
    },
    agentActivityRuntime: runtime,
    agentDirectoryStatus: "ready",
    handledSequence: null,
    markHandled() {},
    nodeId: "node-1",
    onOpenSessionComposerRequest: (request: unknown) => {
      composerRequests.push(request);
    },
    onStateChange() {},
    onSubmit: (request: unknown) => submissions.push(request),
    provider: "codex",
    updateNodeState(updater) {
      updater({
        lastActiveAgentSessionId: "other-session",
        provider: "codex"
      });
    },
    workspaceId: "workspace-1"
  } as Parameters<typeof consumeDesktopAgentGUIOpenSessionActivation>[0] & {
    onOpenSessionComposerRequest(request: unknown): void;
    onSubmit(request: unknown): void;
  });

  assert.deepEqual(selected, [
    {
      agentSessionId: "source-session-9",
      mode: "existing",
      requestId: "workbench-open-session:workspace-1:node-1:source-session-9:19"
    }
  ]);
  assert.deepEqual(composerRequests, [
    {
      agentSessionId: "source-session-9",
      draftPrompt:
        "Please modify [Managed workflow](mention://workspace-issue/issue-managed?workspaceId=workspace-1)",
      focusComposer: true,
      mode: "append",
      sequence: 19
    }
  ]);
  assert.deepEqual(submissions, []);
});

test("acknowledging an open-session append clears only that request", () => {
  const current = {
    agentSessionId: "source-session-9",
    draftPrompt: "Modify the managed issue",
    focusComposer: true,
    mode: "append",
    sequence: 19
  } as const;

  assert.equal(
    clearDesktopAgentGUIOpenSessionComposerRequest(current, 19),
    null
  );
  assert.equal(
    clearDesktopAgentGUIOpenSessionComposerRequest(current, 20),
    current
  );
});
