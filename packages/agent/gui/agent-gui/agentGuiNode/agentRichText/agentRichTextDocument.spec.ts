import { describe, expect, it } from "vitest";
import {
  agentRichTextDocToPromptText,
  plainTextToAgentRichTextDoc,
  plainTextToAgentRichTextInlineContent
} from "./agentRichTextDocument";

describe("agentRichTextDocument", () => {
  it("round-trips plain text and newlines", () => {
    const text = "hello\n\nworld";
    expect(
      agentRichTextDocToPromptText(plainTextToAgentRichTextDoc(text))
    ).toBe(text);
  });

  it("creates an empty paragraph for empty text", () => {
    expect(plainTextToAgentRichTextDoc("")).toEqual({
      type: "doc",
      content: [{ type: "paragraph" }]
    });
    expect(agentRichTextDocToPromptText(plainTextToAgentRichTextDoc(""))).toBe(
      ""
    );
  });

  it("normalizes CRLF text to LF prompt text", () => {
    expect(
      agentRichTextDocToPromptText(plainTextToAgentRichTextDoc("a\r\nb\rc"))
    ).toBe("a\nb\nc");
  });

  it("creates inline content suitable for paste insertion", () => {
    expect(plainTextToAgentRichTextInlineContent("a\nb")).toEqual([
      { type: "text", text: "a" },
      { type: "hardBreak" },
      { type: "text", text: "b" }
    ]);
  });

  it("exports file mention nodes as escaped Markdown links", () => {
    expect(
      agentRichTextDocToPromptText({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "Read " },
              {
                type: "agentFileMention",
                attrs: {
                  name: "a[b] c.md",
                  path: "/workspace/a b\\c).md",
                  kind: "file"
                }
              }
            ]
          }
        ]
      })
    ).toBe("Read [@a\\[b\\] c.md](/workspace/a b\\\\c\\).md)");
  });

  it("hydrates file mention Markdown back into mention nodes", () => {
    expect(
      plainTextToAgentRichTextDoc(
        "Read [@a\\[b\\] c.md](/workspace/a b\\\\c\\).md)\n[@docs](/workspace/docs)"
      )
    ).toEqual({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Read " },
            {
              type: "agentFileMention",
              attrs: {
                name: "a[b] c.md",
                path: "/workspace/a b\\c).md",
                href: "/workspace/a b\\c).md",
                kind: "file",
                entryKind: "unknown",
                directoryPath: "/workspace"
              }
            },
            { type: "hardBreak" },
            {
              type: "agentFileMention",
              attrs: {
                name: "docs",
                path: "/workspace/docs",
                href: "/workspace/docs",
                kind: "file",
                entryKind: "unknown",
                directoryPath: "/workspace"
              }
            }
          ]
        }
      ]
    });
  });

  it("round-trips session and issue mentions as typed mention nodes", () => {
    const prompt =
      "继续看看 [@wang jomes · Codex · 看看项目有什么文件](mention://agent-session?workspaceId=room-1&id=session-1)\n" +
      "再跟进 [@修复 room status 批量接口](mention://workspace-issue?workspaceId=room-1&id=issue-1)";

    expect(
      agentRichTextDocToPromptText(plainTextToAgentRichTextDoc(prompt))
    ).toBe(prompt);

    expect(plainTextToAgentRichTextDoc(prompt)).toEqual({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "继续看看 " },
            {
              type: "agentFileMention",
              attrs: {
                kind: "session",
                href: "mention://agent-session?workspaceId=room-1&id=session-1",
                workspaceId: "room-1",
                targetId: "session-1",
                name: "wang jomes · Codex · 看看项目有什么文件",
                title: "wang jomes · Codex · 看看项目有什么文件",
                scope: "collab_sessions",
                initiatorName: "",
                agentName: ""
              }
            },
            { type: "hardBreak" },
            { type: "text", text: "再跟进 " },
            {
              type: "agentFileMention",
              attrs: {
                kind: "workspace-issue",
                href: "mention://workspace-issue?workspaceId=room-1&id=issue-1",
                workspaceId: "room-1",
                targetId: "issue-1",
                name: "修复 room status 批量接口",
                title: "修复 room status 批量接口"
              }
            }
          ]
        }
      ]
    });
  });

  it("round-trips workspace app factory mentions as typed mention nodes", () => {
    const prompt =
      "[@Create App](mention://workspace-app-factory) Create a weather app.";

    expect(
      agentRichTextDocToPromptText(plainTextToAgentRichTextDoc(prompt))
    ).toBe(prompt);

    expect(plainTextToAgentRichTextDoc(prompt)).toEqual({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "agentFileMention",
              attrs: {
                kind: "workspace-app-factory",
                href: "mention://workspace-app-factory",
                workspaceId: "",
                targetId: "",
                jobId: "",
                name: "Create App",
                action: undefined,
                contextPath: undefined
              }
            },
            { type: "text", text: " Create a weather app." }
          ]
        }
      ]
    });
  });

  it("does not export workspace app icon URLs into prompt text", () => {
    expect(
      agentRichTextDocToPromptText({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "agentFileMention",
                attrs: {
                  kind: "workspace-app",
                  href: "mention://workspace-app?workspaceId=room-1&appId=weather",
                  workspaceId: "room-1",
                  targetId: "weather",
                  appId: "weather",
                  name: "Weather",
                  iconUrl: "data:image/png;base64,abc"
                }
              }
            ]
          }
        ]
      })
    ).toBe(
      "[@Weather](mention://workspace-app?workspaceId=room-1&appId=weather)"
    );
  });

  it("hydrates known skill triggers into skill token nodes", () => {
    const prompt = "Use /caveman and keep /compact";
    const doc = plainTextToAgentRichTextDoc(prompt, {
      skills: [
        {
          name: "caveman",
          trigger: "$caveman",
          sourceKind: "personal"
        }
      ]
    });

    expect(agentRichTextDocToPromptText(doc)).toBe(prompt);
    expect(doc).toEqual({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Use " },
            {
              type: "agentSkillToken",
              attrs: {
                label: "caveman",
                name: "caveman",
                trigger: "/caveman"
              }
            },
            { type: "text", text: " and keep /compact" }
          ]
        }
      ]
    });
  });

  it("hydrates known capability triggers into capability token nodes", () => {
    const prompt = "Use /browser and keep /compact";
    const richTextOptions = {
      capabilities: [
        {
          capability: "browserUse",
          label: "浏览器",
          name: "browser",
          trigger: "/browser"
        }
      ]
    };
    const doc = plainTextToAgentRichTextDoc(prompt, richTextOptions);

    expect(agentRichTextDocToPromptText(doc)).toBe(prompt);
    expect(doc).toEqual({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Use " },
            {
              type: "agentCapabilityToken",
              attrs: {
                capability: "browserUse",
                label: "浏览器",
                name: "browser",
                trigger: "/browser"
              }
            },
            { type: "text", text: " and keep /compact" }
          ]
        }
      ]
    });
  });
});
