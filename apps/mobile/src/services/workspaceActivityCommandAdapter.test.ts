import type {
  AgentActivitySession,
  AgentSessionEngine,
  PromptQueueSendCommand,
  SessionActivateCommand
} from "@tutti-os/agent-activity-core";
import type { TuttidClient } from "@tutti-os/client-tuttid-ts";
import { executeWorkspaceActivityCommand } from "./workspaceActivityCommandAdapter";

describe("executeWorkspaceActivityCommand", () => {
  test("applies required settings before sending every prompt semantic", async () => {
    const operations: string[] = [];
    const requests: Record<string, unknown>[] = [];
    const sendFailure = new Error("stop after request capture");
    const client = {
      async updateWorkspaceAgentSessionSettings(
        _workspaceId: string,
        _agentSessionId: string,
        settings: Record<string, unknown>
      ) {
        operations.push("settings");
        requests.push(settings);
        return {};
      },
      async sendWorkspaceAgentSessionInput(
        _workspaceId: string,
        _agentSessionId: string,
        request: Record<string, unknown>
      ) {
        operations.push("send");
        requests.push(request);
        throw sendFailure;
      }
    } as unknown as TuttidClient;
    const command: PromptQueueSendCommand = {
      agentSessionId: "session-1",
      capabilityRefs: [{ capability: "tutti", source: "slash_command" }],
      clientSubmitId: "submit-1",
      commandId: "command-1",
      content: [{ text: "hello", type: "text" }],
      displayPrompt: "/computer hello",
      guidance: true,
      promptId: "prompt-1",
      requiredSettingsPatch: { computerUse: true },
      submitDiagnostics: {
        blockCount: 1,
        source: "mobile-test",
        submittedAtUnixMs: 10
      },
      type: "queue/sendPrompt",
      workspaceId: "workspace-1"
    };

    await expect(
      executeWorkspaceActivityCommand(
        {
          client,
          engine: {} as AgentSessionEngine,
          loadComposerOptions() {},
          mapSession(): AgentActivitySession {
            throw new Error("unexpected Session mapping");
          },
          mapSessionDetail() {
            throw new Error("unexpected detail mapping");
          },
          async reconcileSession() {},
          async reconcileWorkspace() {}
        },
        command
      )
    ).rejects.toBe(sendFailure);

    expect(operations).toEqual(["settings", "send"]);
    expect(requests).toEqual([
      { computerUse: true },
      {
        capabilityRefs: [{ capability: "tutti", source: "slash_command" }],
        clientSubmitId: "submit-1",
        content: [{ text: "hello", type: "text" }],
        displayPrompt: "/computer hello",
        guidance: true,
        submitDiagnostics: {
          blockCount: 1,
          source: "mobile-test",
          submittedAtUnixMs: 10
        }
      }
    ]);
  });

  test("does not invent computerUse on the generated create contract", async () => {
    let createRequest: Record<string, unknown> | null = null;
    const stopAfterCapture = new Error("stop after create request capture");
    const client = {
      async createWorkspaceAgentSession(
        _workspaceId: string,
        request: Record<string, unknown>
      ) {
        createRequest = request;
        throw stopAfterCapture;
      }
    } as unknown as TuttidClient;
    const command: SessionActivateCommand = {
      agentSessionId: "session-1",
      agentTargetId: "target-1",
      clientSubmitId: "submit-1",
      commandId: "command-1",
      correlationId: "request-1",
      initialContent: [{ text: "hello", type: "text" }],
      mode: "new",
      settings: { computerUse: false },
      type: "session/activate",
      visible: true,
      workspaceId: "workspace-1"
    };

    await expect(
      executeWorkspaceActivityCommand(
        {
          client,
          engine: {} as AgentSessionEngine,
          loadComposerOptions() {},
          mapSession(): AgentActivitySession {
            throw new Error("unexpected Session mapping");
          },
          mapSessionDetail() {
            throw new Error("unexpected detail mapping");
          },
          async reconcileSession() {},
          async reconcileWorkspace() {}
        },
        command
      )
    ).rejects.toBe(stopAfterCapture);

    expect(createRequest).toEqual(
      expect.objectContaining({
        agentSessionId: "session-1",
        agentTargetId: "target-1",
        clientSubmitId: "submit-1"
      })
    );
    expect(createRequest).not.toHaveProperty("computerUse");
  });
});
