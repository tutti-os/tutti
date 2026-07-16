import { describe, expect, it } from "vitest";
import {
  agentComposerDraftDisplayPrompt,
  agentComposerDraftFiles,
  agentComposerDraftHasContent,
  agentComposerDraftImages,
  agentComposerDraftLargeTexts,
  agentComposerDraftPrompt,
  agentComposerDraftSubmittedText,
  agentComposerDraftToPromptContent,
  agentPromptContentDisplayText,
  agentPromptContentToComposerDraft,
  buildAgentComposerDraft,
  emptyAgentComposerDraft,
  extractPastedTextArchivePaths,
  linkifyPastedTextReferences,
  normalizeAgentPromptContentBlocks,
  projectAgentComposerDraftSubmission
} from "./agentComposerDraft";

describe("agentComposerDraft", () => {
  it("stores text, images, files, and pasted text in one ordered content array", () => {
    const draft = buildAgentComposerDraft({
      prompt: "Inspect this",
      images: [
        {
          id: "image-1",
          name: "screen.png",
          mimeType: "image/png",
          previewUrl: "blob:image-1"
        }
      ],
      files: [{ id: "file-1", name: "notes.md" }],
      largeTexts: [
        { id: "paste-1", name: "pasted-text.txt", text: "long body" }
      ]
    });

    expect(draft.map((block) => block.type)).toEqual([
      "text",
      "image",
      "file",
      "file"
    ]);
    expect(draft[2]).toMatchObject({ type: "file", kind: "file" });
    expect(draft[3]).toMatchObject({
      type: "file",
      kind: "pasted-text",
      text: "long body"
    });
  });

  it("preserves safe URL-only image blocks and rejects unsafe or ambiguous sources", () => {
    const signedUrl = "https://bucket.example/image.png?token=secret";
    expect(
      normalizeAgentPromptContentBlocks([
        {
          type: "image",
          mimeType: "image/png",
          url: ` ${signedUrl} `,
          attachmentId: " attachment-1 ",
          name: " screenshot.png "
        }
      ])
    ).toEqual([
      {
        type: "image",
        mimeType: "image/png",
        url: signedUrl,
        attachmentId: "attachment-1",
        name: "screenshot.png"
      }
    ]);
    expect(
      normalizeAgentPromptContentBlocks([
        {
          type: "image",
          mimeType: "image/png",
          url: "http://example.com/a.png"
        },
        {
          type: "image",
          mimeType: "image/png",
          url: signedUrl,
          data: "aW1hZ2U="
        }
      ])
    ).toEqual([]);
  });

  it("normalizes empty drafts", () => {
    const draft = emptyAgentComposerDraft();

    expect(agentComposerDraftHasContent(draft)).toBe(false);
    expect(
      agentComposerDraftToPromptContent({
        draft,
        skills: []
      })
    ).toEqual([]);
  });

  it("converts text-only drafts into prompt content", () => {
    expect(
      agentComposerDraftToPromptContent({
        draft: buildAgentComposerDraft({ prompt: "  run tests  " }),
        skills: []
      })
    ).toEqual([{ type: "text", text: "run tests" }]);
  });

  it("preserves structured mentions as the conversation display prompt", () => {
    const prompt =
      "[@a](mention://browser-element/browser-element%3A1?path=%2Ftmp%2Fa.txt&tag=a&workspaceId=workspace-1) " +
      "[@div](mention://browser-element/browser-element%3A2?path=%2Ftmp%2Fdiv.txt&tag=div&workspaceId=workspace-1) 22222222";

    expect(
      agentComposerDraftDisplayPrompt(buildAgentComposerDraft({ prompt }))
    ).toBe(prompt);
    expect(
      agentComposerDraftDisplayPrompt(
        buildAgentComposerDraft({ prompt: "ordinary text" })
      )
    ).toBeUndefined();
  });

  it("builds prompt-item blocks from the skill invocation contract", () => {
    expect(
      agentComposerDraftToPromptContent({
        draft: buildAgentComposerDraft({
          prompt: "/review-code inspect this"
        }),
        skills: [
          {
            name: "review-code",
            trigger: "$review-code",
            invocation: "promptItem",
            sourceKind: "personal",
            path: "/skills/review-code/SKILL.md"
          }
        ]
      })
    ).toEqual([
      { type: "text", text: "$review-code inspect this" },
      {
        type: "skill",
        name: "review-code",
        path: "/skills/review-code/SKILL.md"
      }
    ]);
  });

  it("projects prompt-item aliases into runtime content while preserving visible text", () => {
    expect(
      projectAgentComposerDraftSubmission({
        draft: buildAgentComposerDraft({
          prompt: "/review-code inspect this"
        }),
        skills: [
          {
            name: "review-code",
            trigger: "$review-code",
            invocation: "promptItem",
            sourceKind: "personal",
            path: "/skills/review-code/SKILL.md"
          }
        ]
      })
    ).toEqual({
      content: [
        { type: "text", text: "$review-code inspect this" },
        {
          type: "skill",
          name: "review-code",
          path: "/skills/review-code/SKILL.md"
        }
      ],
      displayPrompt: "/review-code inspect this"
    });
  });

  it("projects text-trigger aliases into runtime content while preserving visible text", () => {
    expect(
      projectAgentComposerDraftSubmission({
        draft: buildAgentComposerDraft({ prompt: "$foo inspect this" }),
        skills: [
          {
            name: "foo",
            trigger: "/foo",
            invocation: "textTrigger",
            sourceKind: "plugin"
          }
        ]
      })
    ).toEqual({
      content: [{ type: "text", text: "/foo inspect this" }],
      displayPrompt: "$foo inspect this"
    });
  });

  it("omits display prompts for native skill prefixes and ordinary text", () => {
    const skill = {
      name: "review-code",
      trigger: "$review-code",
      invocation: "promptItem" as const,
      sourceKind: "personal" as const,
      path: "/skills/review-code/SKILL.md"
    };

    expect(
      projectAgentComposerDraftSubmission({
        draft: buildAgentComposerDraft({
          prompt: "$review-code inspect this"
        }),
        skills: [skill]
      })
    ).toEqual({
      content: [
        { type: "text", text: "$review-code inspect this" },
        {
          type: "skill",
          name: "review-code",
          path: "/skills/review-code/SKILL.md"
        }
      ]
    });
    expect(
      projectAgentComposerDraftSubmission({
        draft: buildAgentComposerDraft({ prompt: "inspect this" }),
        skills: [skill]
      })
    ).toEqual({ content: [{ type: "text", text: "inspect this" }] });
  });

  it("prefers an explicit rich display prompt over derived submission text", () => {
    const draft = buildAgentComposerDraft({
      prompt: "Summarize this",
      largeTexts: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          name: "pasted-text.txt",
          text: "first line\nsecond line",
          sizeBytes: 22,
          path: "/archive/aa/deadbeef.txt"
        }
      ]
    });

    expect(projectAgentComposerDraftSubmission({ draft, skills: [] })).toEqual({
      content: [
        { type: "text", text: "Summarize this" },
        {
          type: "file",
          kind: "pasted-text",
          path: "/archive/aa/deadbeef.txt",
          name: "first line…",
          sizeBytes: 22
        }
      ],
      displayPrompt:
        "Summarize this\n[@first line…](mention://pasted-text/11111111-1111-4111-8111-111111111111?path=%2Farchive%2Faa%2Fdeadbeef.txt&size=22)"
    });
  });

  it("submits a landed pasted-text draft as a structured file block", () => {
    const draft = buildAgentComposerDraft({
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
    });

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
    const uploading = buildAgentComposerDraft({
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
    });
    const errored = buildAgentComposerDraft({
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
    });

    // A pending/errored chip still counts as content (so the composer is not
    // treated as empty) but never lands in the submitted prompt content.
    expect(agentComposerDraftHasContent(uploading)).toBe(true);
    expect(
      agentComposerDraftToPromptContent({
        draft: uploading,
        skills: []
      })
    ).toEqual([]);
    expect(
      agentComposerDraftToPromptContent({
        draft: errored,
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

    expect(agentComposerDraftPrompt(draft)).toBe("Summarize this");
    expect(agentComposerDraftFiles(draft)).toEqual([]);
    expect(agentComposerDraftLargeTexts(draft)).toHaveLength(1);
    expect(agentComposerDraftLargeTexts(draft)[0]).toMatchObject({
      text: "",
      path: "/archive/aa/deadbeef.txt"
    });
    expect(agentComposerDraftHasContent(draft)).toBe(true);
    expect(agentComposerDraftLargeTexts(draft)[0]).toMatchObject({
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
        draft: buildAgentComposerDraft({
          prompt: "$review $github check this"
        }),
        skills: [
          {
            name: "review",
            trigger: "$review",
            invocation: "promptItem",
            sourceKind: "plugin",
            path: "/tmp/review/SKILL.md",
            kind: "skill"
          },
          {
            name: "GitHub",
            trigger: "$github",
            invocation: "promptItem",
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
        draft: buildAgentComposerDraft({
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
        }),
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

  it("round-trips HTTPS URL image drafts without hydration", () => {
    const url = "https://bucket.example/screen.webp?X-Amz-Signature=secret";
    const draft = agentPromptContentToComposerDraft(
      [
        {
          type: "image",
          mimeType: "image/webp",
          url,
          attachmentId: "attachment-remote",
          name: "screen.webp"
        }
      ],
      "remote"
    );

    expect(agentComposerDraftImages(draft)).toEqual([
      {
        id: "remote:image:0",
        name: "screen.webp",
        mimeType: "image/webp",
        attachmentId: "attachment-remote",
        url,
        previewUrl: url
      }
    ]);
    expect(
      agentComposerDraftToPromptContent({
        draft,
        skills: []
      })
    ).toEqual([
      {
        type: "image",
        mimeType: "image/webp",
        attachmentId: "attachment-remote",
        url,
        name: "screen.webp"
      }
    ]);
  });

  it("round-trips URL-only image drafts when editing queued content", () => {
    const url = "https://bucket.example/queued.png?X-Amz-Signature=secret";
    const draft = agentPromptContentToComposerDraft(
      [
        {
          type: "image",
          mimeType: "image/png",
          url,
          name: "queued.png"
        }
      ],
      "queued"
    );

    expect(agentComposerDraftImages(draft)).toEqual([
      {
        id: "queued:image:0",
        name: "queued.png",
        mimeType: "image/png",
        url,
        previewUrl: url
      }
    ]);
    expect(
      agentComposerDraftToPromptContent({
        draft,
        skills: []
      })
    ).toEqual([
      {
        type: "image",
        mimeType: "image/png",
        url,
        name: "queued.png"
      }
    ]);
  });

  it("converts attachment-backed image-only drafts into prompt content", () => {
    expect(
      agentComposerDraftToPromptContent({
        draft: buildAgentComposerDraft({
          prompt: "",
          images: [
            {
              id: "image-1",
              name: "screen.png",
              mimeType: "image/png",
              attachmentId: "attachment-1",
              previewUrl: "data:image/png;base64,aW1hZ2U="
            }
          ]
        }),
        skills: []
      })
    ).toEqual([
      {
        type: "image",
        mimeType: "image/png",
        attachmentId: "attachment-1",
        name: "screen.png"
      }
    ]);
  });

  it("converts staged image drafts into path prompt content", () => {
    expect(
      agentComposerDraftToPromptContent({
        draft: buildAgentComposerDraft({
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
        }),
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
        draft: buildAgentComposerDraft({
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
        }),
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

    expect(draft).toEqual(
      buildAgentComposerDraft({
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
      })
    );
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

    expect(draft).toEqual(
      buildAgentComposerDraft({
        prompt: "",
        files: [],
        images: [
          {
            id: "restore-queued-1:image:0",
            name: "panel.png",
            mimeType: "image/png",
            path: "/var/cache/tsh/local-assets/workspace-1/user-1/panel.png",
            previewUrl:
              "/var/cache/tsh/local-assets/workspace-1/user-1/panel.png"
          }
        ]
      })
    );
  });

  it("restores attachment-backed image content into stable draft ids", () => {
    const draft = agentPromptContentToComposerDraft(
      [
        {
          type: "image",
          mimeType: "image/png",
          attachmentId: "attachment-1",
          name: "panel.png"
        }
      ],
      "restore-queued-1"
    );

    expect(draft).toEqual(
      buildAgentComposerDraft({
        prompt: "",
        files: [],
        images: [
          {
            id: "restore-queued-1:image:0",
            name: "panel.png",
            mimeType: "image/png",
            attachmentId: "attachment-1",
            previewUrl: ""
          }
        ]
      })
    );
  });

  it("converts local file drafts into prompt content", () => {
    expect(
      agentComposerDraftToPromptContent({
        draft: buildAgentComposerDraft({
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
        }),
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
