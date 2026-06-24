import { describe, expect, it } from "vitest";
import {
  agentComposerDraftHasContent,
  agentComposerDraftToPromptContent,
  agentPromptContentDisplayText,
  agentPromptContentToComposerDraft,
  emptyAgentComposerDraft
} from "./agentComposerDraft";

describe("agentComposerDraft", () => {
  it("normalizes empty drafts", () => {
    const draft = emptyAgentComposerDraft();

    expect(agentComposerDraftHasContent(draft)).toBe(false);
    expect(
      agentComposerDraftToPromptContent({
        draft,
        provider: "codex",
        skills: []
      })
    ).toEqual([]);
  });

  it("converts text-only drafts into prompt content", () => {
    expect(
      agentComposerDraftToPromptContent({
        draft: { prompt: "  run tests  ", images: [] },
        provider: "codex",
        skills: []
      })
    ).toEqual([{ type: "text", text: "run tests" }]);
  });

  it("adds codex app-server prompt items for referenced skills and connectors", () => {
    expect(
      agentComposerDraftToPromptContent({
        draft: { prompt: "$review $github check this", images: [] },
        provider: "codex",
        skills: [
          {
            name: "review",
            trigger: "$review",
            sourceKind: "plugin",
            path: "/tmp/review/SKILL.md",
            kind: "skill"
          },
          {
            name: "GitHub",
            trigger: "$github",
            sourceKind: "connector",
            path: "app://github",
            kind: "connector"
          }
        ]
      })
    ).toEqual([
      { type: "text", text: "$review $github check this" },
      { type: "skill", name: "review", path: "/tmp/review/SKILL.md" },
      { type: "mention", name: "GitHub", path: "app://github" }
    ]);
  });

  it("converts image-only drafts into prompt content", () => {
    expect(
      agentComposerDraftToPromptContent({
        draft: {
          prompt: "",
          images: [
            {
              id: "image-1",
              name: "screen.png",
              mimeType: "image/png",
              data: "aW1hZ2U=",
              previewUrl: "data:image/png;base64,aW1hZ2U="
            }
          ]
        },
        provider: "codex",
        skills: []
      })
    ).toEqual([
      {
        type: "image",
        mimeType: "image/png",
        data: "aW1hZ2U=",
        name: "screen.png"
      }
    ]);
  });

  it("converts staged image drafts into path prompt content", () => {
    expect(
      agentComposerDraftToPromptContent({
        draft: {
          prompt: "",
          images: [
            {
              id: "image-1",
              name: "screen.png",
              mimeType: "image/png",
              path: "/var/cache/tsh/agent-assets/workspace-1/user-1/screen.png",
              previewUrl: "data:image/png;base64,aW1hZ2U="
            }
          ]
        },
        provider: "codex",
        skills: []
      })
    ).toEqual([
      {
        type: "image",
        mimeType: "image/png",
        path: "/var/cache/tsh/agent-assets/workspace-1/user-1/screen.png",
        name: "screen.png"
      }
    ]);
  });

  it("does not emit image drafts that are still uploading or failed", () => {
    expect(
      agentComposerDraftToPromptContent({
        draft: {
          prompt: "",
          images: [
            {
              id: "image-1",
              name: "uploading.png",
              mimeType: "image/png",
              data: "aW1hZ2U=",
              previewUrl: "data:image/png;base64,aW1hZ2U=",
              uploading: true
            },
            {
              id: "image-2",
              name: "failed.png",
              mimeType: "image/png",
              data: "aW1hZ2U=",
              previewUrl: "data:image/png;base64,aW1hZ2U=",
              uploadError: "failed"
            }
          ]
        },
        provider: "codex",
        skills: []
      })
    ).toEqual([]);
  });

  it("restores text and image content into stable draft ids", () => {
    const draft = agentPromptContentToComposerDraft(
      [
        { type: "text", text: "describe this" },
        {
          type: "image",
          mimeType: "image/png",
          data: "aW1hZ2U=",
          name: "panel.png"
        }
      ],
      "restore-queued-1"
    );

    expect(draft).toEqual({
      prompt: "describe this",
      images: [
        {
          id: "restore-queued-1:image:0",
          name: "panel.png",
          mimeType: "image/png",
          data: "aW1hZ2U=",
          previewUrl: "data:image/png;base64,aW1hZ2U="
        }
      ]
    });
  });

  it("restores path image content into stable draft ids", () => {
    const draft = agentPromptContentToComposerDraft(
      [
        {
          type: "image",
          mimeType: "image/png",
          path: "/var/cache/tsh/agent-assets/workspace-1/user-1/panel.png",
          name: "panel.png"
        }
      ],
      "restore-queued-1"
    );

    expect(draft).toEqual({
      prompt: "",
      images: [
        {
          id: "restore-queued-1:image:0",
          name: "panel.png",
          mimeType: "image/png",
          path: "/var/cache/tsh/agent-assets/workspace-1/user-1/panel.png",
          previewUrl: "/var/cache/tsh/agent-assets/workspace-1/user-1/panel.png"
        }
      ]
    });
  });

  it("derives display text from text content only", () => {
    expect(
      agentPromptContentDisplayText([
        { type: "text", text: "first" },
        { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
        { type: "text", text: "second" }
      ])
    ).toBe("first\nsecond");
  });
});
