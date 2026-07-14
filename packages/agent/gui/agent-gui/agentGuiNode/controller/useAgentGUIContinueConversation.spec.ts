import { describe, expect, it } from "vitest";
import {
  agentComposerDraftFiles,
  agentComposerDraftImages,
  agentComposerDraftLargeTexts,
  agentComposerDraftPrompt,
  buildAgentComposerDraft
} from "../model/agentComposerDraft";
import { buildContinueInNewConversationDraft } from "./useAgentGUIContinueConversation";

describe("buildContinueInNewConversationDraft", () => {
  it("preserves every attachment block while replacing the continuation prompt", () => {
    const sourceDraft = buildAgentComposerDraft({
      prompt: "unsent follow-up",
      images: [
        {
          id: "image-1",
          name: "screen.png",
          mimeType: "image/png",
          previewUrl: "blob:image-1",
          uploading: true
        }
      ],
      files: [{ id: "file-1", name: "notes.md", path: "/workspace/notes.md" }],
      largeTexts: [
        {
          id: "paste-1",
          name: "pasted-text.txt",
          text: "pasted body",
          path: "/archive/paste-1.txt"
        }
      ]
    });

    const continued = buildContinueInNewConversationDraft({
      sourceDraft,
      prompt: "continue mention\nunsent follow-up"
    });

    expect(agentComposerDraftPrompt(continued)).toBe(
      "continue mention\nunsent follow-up"
    );
    expect(agentComposerDraftImages(continued)).toEqual(
      agentComposerDraftImages(sourceDraft)
    );
    expect(agentComposerDraftFiles(continued)).toEqual(
      agentComposerDraftFiles(sourceDraft)
    );
    expect(agentComposerDraftLargeTexts(continued)).toEqual(
      agentComposerDraftLargeTexts(sourceDraft)
    );
  });
});
