import assert from "node:assert/strict";
import test from "node:test";
import type {
  PromptQueueSendCommand,
  TuttiModeActivationUpdateCommand
} from "@tutti-os/agent-activity-core";
import {
  executeWorkspaceAgentPromptSendCommand,
  executeWorkspaceAgentTuttiModeUpdateCommand
} from "./workspaceAgentSessionEngineHost.ts";

test("prompt command applies required settings before sending input", async () => {
  const calls: string[] = [];
  const command = promptCommand({ computerUse: true });

  await executeWorkspaceAgentPromptSendCommand(
    {
      updateSessionSettings: async (input) => {
        calls.push("settings");
        assert.deepEqual(input, {
          agentSessionId: "session-1",
          settings: { computerUse: true },
          workspaceId: "workspace-1"
        });
        return {} as never;
      },
      sendInput: async (input) => {
        calls.push("prompt");
        assert.equal(input.clientSubmitId, "submit-1");
        assert.deepEqual(input.capabilityRefs, [
          { capability: "tutti", source: "slash_command" }
        ]);
      }
    },
    command
  );

  assert.deepEqual(calls, ["settings", "prompt"]);
});

test("prompt command does not send when its required settings fail", async () => {
  let sent = false;
  await assert.rejects(
    executeWorkspaceAgentPromptSendCommand(
      {
        updateSessionSettings: async () => {
          throw new Error("settings failed");
        },
        sendInput: async () => {
          sent = true;
        }
      },
      promptCommand({ browserUse: true })
    ),
    /settings failed/
  );
  assert.equal(sent, false);
});

test("Tutti mode update command preserves the canonical CAS revision", async () => {
  const controller = new AbortController();
  let received: unknown;
  await executeWorkspaceAgentTuttiModeUpdateCommand(
    {
      updateTuttiModeActivation: async (input) => {
        received = input;
        return {} as never;
      }
    },
    {
      agentSessionId: "session-1",
      commandId: "tutti-1",
      expectedRevision: 3,
      source: "badge_remove",
      status: "inactive",
      type: "tuttiMode/update",
      workspaceId: "workspace-1"
    } satisfies TuttiModeActivationUpdateCommand,
    controller.signal
  );

  assert.deepEqual(received, {
    agentSessionId: "session-1",
    expectedRevision: 3,
    signal: controller.signal,
    source: "badge_remove",
    status: "inactive",
    workspaceId: "workspace-1"
  });
});

function promptCommand(
  requiredSettingsPatch: NonNullable<
    PromptQueueSendCommand["requiredSettingsPatch"]
  >
): PromptQueueSendCommand {
  return {
    type: "queue/sendPrompt",
    agentSessionId: "session-1",
    capabilityRefs: [{ capability: "tutti", source: "slash_command" }],
    clientSubmitId: "submit-1",
    commandId: "command-1",
    content: [{ type: "text", text: "runtime prompt" }],
    displayPrompt: "/computer test",
    promptId: "prompt-1",
    requiredSettingsPatch,
    workspaceId: "workspace-1"
  };
}
