import { describe, expect, it } from "vitest";
import type { WorkspaceAgentSessionDetailMessage } from "../../workspaceAgentSessionDetailViewModel";
import { projectConversationUserRow } from "./agentConversationUserProjection";

describe("projectConversationUserRow", () => {
  it("preserves prompt image restore metadata from historical message content", () => {
    const message: WorkspaceAgentSessionDetailMessage = {
      id: "message-1",
      body: "",
      turnId: "turn-1",
      sourceTimelineItems: [
        {
          id: 1,
          workspaceId: "workspace-1",
          agentSessionId: "session-1",
          eventId: "event-1",
          actorType: "user",
          actorId: "user-1",
          itemType: "message",
          payload: {
            content: [
              {
                type: "image",
                mimeType: "image/png",
                name: "screen.png",
                path: "/agent-prompt-assets/screen.png",
                uri: "workspace/user/local-assets/sha.png",
                hostPath: "/Users/me/screen.png",
                assetId: "asset-1",
                kind: "image",
                uploadStatus: "uploaded",
                storagePolicy: "cloud-backed"
              }
            ]
          }
        }
      ]
    };

    expect(
      projectConversationUserRow(message, "turn-fallback", "workspace-fallback")
        .messages[0]?.images?.[0]
    ).toMatchObject({
      workspaceId: "workspace-1",
      agentSessionId: "session-1",
      path: "/agent-prompt-assets/screen.png",
      uri: "workspace/user/local-assets/sha.png",
      hostPath: "/Users/me/screen.png",
      assetId: "asset-1",
      kind: "image",
      uploadStatus: "uploaded",
      storagePolicy: "cloud-backed"
    });
  });
});
