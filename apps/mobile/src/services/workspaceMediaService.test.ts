import type { AgentConversationVM } from "@tutti-os/agent-gui/conversation-projection";
import type { TuttidClient } from "@tutti-os/client-tuttid-ts";
import { WorkspaceMediaService } from "./workspaceMediaService";

describe("WorkspaceMediaService", () => {
  it("loads canonical message attachments once and exposes a data URI", async () => {
    const readWorkspaceAgentSessionAttachment = jest.fn().mockResolvedValue({
      attachmentId: "attachment-1",
      data: "aW1hZ2U=",
      mimeType: "image/png"
    });
    const service = new WorkspaceMediaService("workspace-1", {
      readWorkspaceAgentSessionAttachment
    } as unknown as TuttidClient);
    const conversation = {
      rows: [
        {
          kind: "message",
          messages: [
            {
              images: [
                {
                  agentSessionId: "session-1",
                  attachmentId: "attachment-1",
                  id: "image-1",
                  mimeType: "image/png",
                  workspaceId: "workspace-1"
                }
              ]
            }
          ]
        }
      ]
    } as AgentConversationVM;

    service.sync(conversation);
    await Promise.resolve();
    await Promise.resolve();
    service.sync(conversation);

    expect(readWorkspaceAgentSessionAttachment).toHaveBeenCalledTimes(1);
    expect(service.getSnapshot().sourcesByImageId["image-1"]).toBe(
      "data:image/png;base64,aW1hZ2U="
    );
  });
});
