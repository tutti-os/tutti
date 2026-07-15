import { describe, expect, it } from "vitest";
import { conversationPlainTitle } from "./agentGUIViewUtils";

describe("conversationPlainTitle", () => {
  it("uses the host-injected untitled label", () => {
    expect(
      conversationPlainTitle(
        { title: "", titleFallback: "untitled-conversation" },
        { untitledConversationTitle: "Host untitled override" },
        "en"
      )
    ).toBe("Host untitled override");
  });
});
