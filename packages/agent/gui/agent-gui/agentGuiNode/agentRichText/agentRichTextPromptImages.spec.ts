import { describe, expect, it } from "vitest";
import { classifyAgentRichTextExternalFiles } from "./agentRichTextPromptImages";

describe("classifyAgentRichTextExternalFiles", () => {
  it("keeps supported images and regular files from one clipboard transfer", () => {
    const image = new File(["image"], "screen.png", { type: "image/png" });
    const document = new File(["document"], "notes.md", {
      type: "text/markdown"
    });
    const dataTransfer = {
      files: [image, document]
    } as unknown as DataTransfer;

    expect(classifyAgentRichTextExternalFiles(dataTransfer)).toEqual({
      imageFiles: [image],
      regularFiles: [document]
    });
  });
});
