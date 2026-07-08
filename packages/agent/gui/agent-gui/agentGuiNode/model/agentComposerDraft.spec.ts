import { describe, expect, it } from "vitest";
import {
  agentComposerDraftDisplayPrompt,
  agentComposerDraftHasContent,
  agentComposerDraftSubmittedText,
  agentComposerDraftToPromptContent,
  agentPromptContentDisplayText,
  agentPromptContentToComposerDraft,
  emptyAgentComposerDraft,
  extractPastedTextArchivePaths,
  linkifyPastedTextReferences
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

  it("submits a landed pasted-text draft as a structured file block", () => {
    const draft = {
      prompt: "Summarize this",
      images: [],
      largeTexts: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          name: "pasted-text.txt",
          text: "first line\nsecond line",
          sizeBytes: 22,
          path: "/archive/aa/deadbeef.txt"
        }
      ]
    };

    expect(agentComposerDraftHasContent(draft)).toBe(true);
    // The conversation-flow display prompt encodes the landed pasted text as a
    // pasted-text mention link (path + size in the href) so the host can render
    // a clickable chip; the raw text body never enters it.
    expect(agentComposerDraftDisplayPrompt(draft)).toBe(
      "Summarize this\n[@first line…](mention://pasted-text/11111111-1111-4111-8111-111111111111?path=%2Farchive%2Faa%2Fdeadbeef.txt&size=22)"
    );
    expect(
      agentComposerDraftToPromptContent({
        draft,
        provider: "codex",
        skills: []
      })
    ).toEqual([
      { type: "text", text: "Summarize this" },
      {
        type: "file",
        kind: "pasted-text",
        path: "/archive/aa/deadbeef.txt",
        // Block name carries the preview (first chars + ellipsis) so the
        // send-time instruction can persist it in content.
        name: "first line…",
        sizeBytes: 22
      }
    ]);
    // No translated instruction and no inlined body enter the submitted text.
    expect(agentComposerDraftSubmittedText(draft)).toBe("Summarize this");
  });

  it("keeps an uploading or errored pasted-text draft out of submit content", () => {
    const uploading = {
      prompt: "",
      images: [],
      largeTexts: [
        {
          id: "22222222-2222-4222-8222-222222222222",
          name: "pasted-text.txt",
          text: "still uploading",
          uploading: true
        }
      ]
    };
    const errored = {
      prompt: "",
      images: [],
      largeTexts: [
        {
          id: "33333333-3333-4333-8333-333333333333",
          name: "pasted-text.txt",
          text: "failed",
          uploadError: "disk full"
        }
      ]
    };

    // A pending/errored chip still counts as content (so the composer is not
    // treated as empty) but never lands in the submitted prompt content.
    expect(agentComposerDraftHasContent(uploading)).toBe(true);
    expect(
      agentComposerDraftToPromptContent({
        draft: uploading,
        provider: "codex",
        skills: []
      })
    ).toEqual([]);
    expect(
      agentComposerDraftToPromptContent({
        draft: errored,
        provider: "codex",
        skills: []
      })
    ).toEqual([]);
  });

  it("restores a pasted-text file block back into a large-text chip", () => {
    const draft = agentPromptContentToComposerDraft(
      [
        { type: "text", text: "Summarize this" },
        {
          type: "file",
          kind: "pasted-text",
          path: "/archive/aa/deadbeef.txt",
          name: "pasted-text.txt",
          sizeBytes: 22
        }
      ],
      "restore-1"
    );

    expect(draft.prompt).toBe("Summarize this");
    expect(draft.files ?? []).toEqual([]);
    expect(draft.largeTexts).toHaveLength(1);
    expect(draft.largeTexts?.[0]).toMatchObject({
      name: "pasted-text.txt",
      path: "/archive/aa/deadbeef.txt",
      sizeBytes: 22,
      text: ""
    });
  });

  it("materializes the codex-style instruction only at send time", async () => {
    const { materializePastedTextInstructions } =
      await import("./agentComposerDraft");
    const content = [
      { type: "text" as const, text: "Summarize this" },
      {
        type: "file" as const,
        kind: "pasted-text",
        path: "/archive/aa/deadbeef.txt",
        name: "first line"
      }
    ];

    // The pasted-text file block is stripped and replaced by the instruction
    // text (preview quoted + path embedded); no file block survives.
    expect(
      materializePastedTextInstructions(content, {
        header: () => "Referenced pasted text files:",
        line: (preview, path) =>
          `- pasted text file "${preview}": ${path}. Read this file before continuing.`
      })
    ).toEqual([
      { type: "text", text: "Summarize this" },
      {
        type: "text",
        text: 'Referenced pasted text files:\n- pasted text file "first line": /archive/aa/deadbeef.txt. Read this file before continuing.'
      }
    ]);

    // No pasted-text blocks → content returned unchanged.
    expect(
      materializePastedTextInstructions([{ type: "text", text: "hi" }], {
        header: () => "H",
        line: (_preview, path) => path
      })
    ).toEqual([{ type: "text", text: "hi" }]);
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
              path: "/var/cache/tsh/local-assets/workspace-1/user-1/screen.png",
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
        path: "/var/cache/tsh/local-assets/workspace-1/user-1/screen.png",
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
      files: [],
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
          path: "/var/cache/tsh/local-assets/workspace-1/user-1/panel.png",
          name: "panel.png"
        }
      ],
      "restore-queued-1"
    );

    expect(draft).toEqual({
      prompt: "",
      files: [],
      images: [
        {
          id: "restore-queued-1:image:0",
          name: "panel.png",
          mimeType: "image/png",
          path: "/var/cache/tsh/local-assets/workspace-1/user-1/panel.png",
          previewUrl: "/var/cache/tsh/local-assets/workspace-1/user-1/panel.png"
        }
      ]
    });
  });

  it("converts local file drafts into prompt content", () => {
    expect(
      agentComposerDraftToPromptContent({
        draft: {
          prompt: "",
          images: [],
          files: [
            {
              id: "file-1",
              name: "report.pdf",
              mimeType: "application/pdf",
              path: "/var/cache/tsh/local-assets/workspace-1/user-1/report.pdf",
              hostPath: "/Users/me/report.pdf",
              assetId: "asset-1",
              sizeBytes: 42
            }
          ]
        },
        provider: "codex",
        skills: []
      })
    ).toEqual([
      {
        type: "file",
        mimeType: "application/pdf",
        path: "/var/cache/tsh/local-assets/workspace-1/user-1/report.pdf",
        assetId: "asset-1",
        sizeBytes: 42,
        name: "report.pdf",
        kind: "file"
      }
    ]);
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

  it("extracts landed pasted-text archive paths from persisted instruction text (paths may contain spaces)", () => {
    const text =
      "Referenced pasted text files:\n" +
      '- pasted text file "first line": /Users/z/Library/Application Support/Tutti-dev/agent-prompt-assets/room-1/ab/deadbeef.txt. Read this file before continuing.';
    expect(extractPastedTextArchivePaths(text)).toEqual([
      "/Users/z/Library/Application Support/Tutti-dev/agent-prompt-assets/room-1/ab/deadbeef.txt"
    ]);
  });

  it("rewrites persisted pasted-text instruction text into mention chips (reload-safe, preview label persists)", () => {
    const text =
      "Referenced pasted text files:\n" +
      '- pasted text file "first line": /home/u/agent-prompt-assets/r/ab/deadbeef.txt. Read this file before continuing.';
    // The localized header/instruction wording is dropped; the chip mention
    // keeps the quoted preview as its label and the path in the href — matching
    // the optimistic display.
    expect(linkifyPastedTextReferences(text)).toBe(
      "[@first line](mention://pasted-text/ref-0?path=%2Fhome%2Fu%2Fagent-prompt-assets%2Fr%2Fab%2Fdeadbeef.txt)"
    );
  });

  it("leaves text without pasted-text references unchanged", () => {
    expect(linkifyPastedTextReferences("just a normal message")).toBe(
      "just a normal message"
    );
  });
});
