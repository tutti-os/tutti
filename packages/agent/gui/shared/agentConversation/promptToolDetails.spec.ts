import { describe, expect, it } from "vitest";
import { getPromptToolDetails } from "./promptToolDetails";

describe("getPromptToolDetails", () => {
  it("surfaces file-change paths from direct approval input", () => {
    expect(
      getPromptToolDetails({
        fileChanges: {
          "src/app.ts": { kind: "modified" },
          "src/utils.ts": { kind: "created" },
          "src/notes.ts": { kind: "deleted" },
          "src/extra.ts": { kind: "modified" }
        }
      })
    ).toEqual([
      {
        kind: "files",
        value: "src/app.ts, src/utils.ts, src/notes.ts +1 more"
      }
    ]);
  });

  it("surfaces nested toolCall file-change file lists", () => {
    expect(
      getPromptToolDetails({
        toolCall: {
          input: {
            fileChanges: {
              files: [
                { path: "docs/readme.md", kind: "modified" },
                { path: "docs/guide.md", kind: "created" }
              ]
            }
          }
        }
      })
    ).toEqual([
      {
        kind: "files",
        value: "docs/readme.md, docs/guide.md"
      }
    ]);
  });

  it("prefers recovered approval changes over an empty request toolCall input", () => {
    expect(
      getPromptToolDetails({
        requestId: "approval-1",
        changes: [
          { path: "src/app.ts", kind: { type: "update" } },
          { path: "src/game.ts", kind: { type: "create" } }
        ],
        toolCall: {
          input: {},
          kind: "edit",
          title: "Apply file changes",
          toolCallId: "item-file-change"
        }
      })
    ).toEqual([
      {
        kind: "files",
        value: "src/app.ts, src/game.ts"
      }
    ]);
  });

  it("shows absolute file changes relative to their common directory", () => {
    expect(
      getPromptToolDetails({
        changes: [
          { path: "/workspace/session/app.js" },
          { path: "/workspace/session/index.html" },
          { path: "/workspace/session/styles.css" }
        ],
        path: "/workspace/session/app.js"
      })
    ).toEqual([
      {
        kind: "files",
        value: "app.js, index.html, styles.css"
      },
      {
        kind: "directory",
        value: "/workspace/session"
      }
    ]);
  });

  it("surfaces grantRoot approval scopes as paths", () => {
    expect(
      getPromptToolDetails({
        grantRoot: "/Users/vector/Documents/CODES/WORK_SPACE_MAIN/tutti"
      })
    ).toEqual([
      {
        kind: "path",
        value: "/Users/vector/Documents/CODES/WORK_SPACE_MAIN/tutti"
      }
    ]);
  });

  it("surfaces approval reasons when no other detail is available", () => {
    expect(
      getPromptToolDetails({
        reason: "Do you want to allow the file changes?"
      })
    ).toEqual([
      {
        kind: "reason",
        value: "Do you want to allow the file changes?"
      }
    ]);
  });

  it("does not duplicate a command description as a separate reason", () => {
    expect(
      getPromptToolDetails({
        command: "pnpm test --run renderer",
        description: "Verify the renderer parity fixes."
      })
    ).toEqual([
      {
        kind: "command",
        value: "pnpm test --run renderer",
        meta: "Verify the renderer parity fixes."
      }
    ]);
  });

  it("surfaces approval details from nested toolCall inputs", () => {
    expect(
      getPromptToolDetails({
        requestId: "approval-2",
        options: [{ optionId: "approve", label: "Allow" }],
        toolCall: {
          kind: "edit",
          title: "Apply file changes",
          toolCallId: "call-2",
          input: {
            reason: "Do you want to allow the file changes?",
            grantRoot: "/Users/vector/Documents/CODES/WORK_SPACE_MAIN/tutti"
          }
        }
      })
    ).toEqual([
      {
        kind: "path",
        value: "/Users/vector/Documents/CODES/WORK_SPACE_MAIN/tutti"
      },
      {
        kind: "reason",
        value: "Do you want to allow the file changes?"
      }
    ]);
  });

  it("surfaces web approval details from canonical root input", () => {
    expect(
      getPromptToolDetails({
        requestId: "approval-web-1",
        url: "https://example.com/docs",
        prompt: "Summarize this page",
        options: [{ optionId: "approve", label: "Allow" }],
        toolCall: {
          toolCallId: "call-web-1",
          name: "WebFetch",
          title: "WebFetch",
          toolName: "WebFetch"
        }
      })
    ).toEqual([
      {
        kind: "url",
        value: "https://example.com/docs"
      },
      {
        kind: "prompt",
        value: "Summarize this page"
      }
    ]);
  });

  it("supports URI and instruction aliases in nested toolCall input", () => {
    expect(
      getPromptToolDetails({
        toolCall: {
          input: {
            uri: "https://example.com/reference",
            instruction: "Extract the compatibility requirements"
          }
        }
      })
    ).toEqual([
      {
        kind: "url",
        value: "https://example.com/reference"
      },
      {
        kind: "prompt",
        value: "Extract the compatibility requirements"
      }
    ]);
  });

  it("merges web approval details split across root and nested input", () => {
    expect(
      getPromptToolDetails({
        url: "https://example.com/root",
        toolCall: {
          input: {
            prompt: "Use the nested prompt"
          }
        }
      })
    ).toEqual([
      {
        kind: "url",
        value: "https://example.com/root"
      },
      {
        kind: "prompt",
        value: "Use the nested prompt"
      }
    ]);

    expect(
      getPromptToolDetails({
        instruction: "Use the root instruction",
        toolCall: {
          input: {
            uri: "https://example.com/nested"
          }
        }
      })
    ).toEqual([
      {
        kind: "url",
        value: "https://example.com/nested"
      },
      {
        kind: "prompt",
        value: "Use the root instruction"
      }
    ]);
  });

  it("prefers nested values across equivalent detail aliases", () => {
    expect(
      getPromptToolDetails({
        command: "root command",
        grantRoot: "/root/scope",
        query: "root query",
        url: "https://root.example",
        prompt: "root prompt",
        fileChanges: [{ path: "root/file.ts" }],
        toolCall: {
          input: {
            cmd: "nested command",
            path: "/nested/scope",
            searchQuery: "nested query",
            uri: "https://nested.example",
            instruction: "nested prompt",
            changes: [{ path: "nested/file.ts" }]
          }
        }
      })
    ).toEqual([
      {
        kind: "files",
        value: "nested/file.ts"
      },
      {
        kind: "command",
        value: "nested command"
      },
      {
        kind: "path",
        value: "/nested/scope"
      },
      {
        kind: "query",
        value: "nested query"
      },
      {
        kind: "url",
        value: "https://nested.example"
      },
      {
        kind: "prompt",
        value: "nested prompt"
      }
    ]);
  });

  it("keeps command and path metadata with their source detail layer", () => {
    expect(
      getPromptToolDetails({
        command: "root command",
        description: "root command description",
        path: "/root/file.ts",
        startLine: 10,
        endLine: 11,
        toolCall: {
          input: {
            cmd: "nested command",
            filePath: "/nested/file.ts"
          }
        }
      })
    ).toEqual([
      {
        kind: "command",
        value: "nested command"
      },
      {
        kind: "path",
        value: "/nested/file.ts"
      }
    ]);
  });
});
