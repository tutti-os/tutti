import assert from "node:assert/strict";
import test from "node:test";
import type { AgentActivityRuntime } from "@tutti-os/agent-gui";
import { desktopAgentGUIOpenSessionActivationType } from "../desktopAgentGUINodeState.ts";
import { consumeDesktopAgentGUIOpenSessionActivation } from "./desktopAgentGUIOpenSessionActivation.ts";

test("source-session activation selects the exact session and requests a non-submitting composer append", async () => {
  const selected: unknown[] = [];
  const composerRequests: unknown[] = [];
  const submissions: unknown[] = [];
  const runtime = {
    async activateSession(input: unknown) {
      selected.push(input);
      return {};
    }
  } as unknown as Pick<AgentActivityRuntime, "activateSession">;

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

  await Promise.resolve();

  assert.deepEqual(selected, [
    {
      agentSessionId: "source-session-9",
      mode: "existing",
      workspaceId: "workspace-1"
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
