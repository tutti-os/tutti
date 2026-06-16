import { describe, expect, it } from "vitest";
import { resolveWorkspaceMentionLinkAction } from "./workspaceLinkActions";

describe("renderer workspaceLinkActions wrapper", () => {
  it("re-exports the canonical workspace link actions", () => {
    expect(
      resolveWorkspaceMentionLinkAction({
        href: "mention://workspace-app?workspaceId=workspace-1&appId=weather",
        source: "agent-markdown"
      })
    ).toEqual({
      type: "open-workspace-app",
      workspaceId: "workspace-1",
      appId: "weather",
      source: "agent-markdown"
    });
  });
});
