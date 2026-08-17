import { setAgentGuiI18nTestLocale } from "../../i18n/testUtils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { presentAgentGeneratedFileMentionItems } from "./agentMentionAgentGeneratedFilesPresentation";
import type { AgentMentionFileItem } from "./agentRichText/agentFileMentionExtension";

function fileItem(
  overrides: Partial<AgentMentionFileItem> &
    Pick<AgentMentionFileItem, "path" | "name">
): AgentMentionFileItem {
  return {
    kind: "file",
    href: overrides.path,
    entryKind: "unknown",
    directoryPath: overrides.directoryPath ?? "/workspace/demo",
    ...overrides
  };
}

describe("presentAgentGeneratedFileMentionItems", () => {
  beforeEach(() => {
    setAgentGuiI18nTestLocale("zh-CN");
  });

  afterEach(() => {
    setAgentGuiI18nTestLocale("en");
  });

  it("groups multiple files in the same directory into a folder entry", () => {
    const files = [
      fileItem({
        path: "/workspace/demo/static/app.js",
        name: "app.js",
        directoryPath: "/workspace/demo/static"
      }),
      fileItem({
        path: "/workspace/demo/static/index.html",
        name: "index.html",
        directoryPath: "/workspace/demo/static"
      }),
      fileItem({
        path: "/workspace/demo/static/styles.css",
        name: "styles.css",
        directoryPath: "/workspace/demo/static"
      }),
      fileItem({
        path: "/workspace/demo/apps/11.md",
        name: "11.md",
        directoryPath: "/workspace/demo/apps"
      })
    ];

    const presented = presentAgentGeneratedFileMentionItems({
      files,
      browsePath: null,
      query: ""
    });

    expect(presented).toHaveLength(2);
    expect(presented[0]).toMatchObject({
      kind: "file",
      name: "11.md",
      path: "/workspace/demo/apps/11.md"
    });
    expect(presented[1]).toMatchObject({
      kind: "file",
      name: "static",
      path: "/workspace/demo/static",
      entryKind: "directory",
      mentionNavigation: "agent-generated-folder",
      childCount: 3
    });
  });

  it("shows files inside a selected folder with a back row", () => {
    const files = [
      fileItem({
        path: "/workspace/demo/static/app.js",
        name: "app.js",
        directoryPath: "/workspace/demo/static"
      }),
      fileItem({
        path: "/workspace/demo/static/index.html",
        name: "index.html",
        directoryPath: "/workspace/demo/static"
      })
    ];

    const presented = presentAgentGeneratedFileMentionItems({
      files,
      browsePath: "/workspace/demo/static",
      query: ""
    });

    expect(presented).toHaveLength(3);
    expect(presented[0]).toMatchObject({
      mentionNavigation: "agent-generated-folder-back",
      name: "返回"
    });
    expect(
      presented.slice(1).map((item) => item.kind === "file" && item.name)
    ).toEqual(["app.js", "index.html"]);
  });

  it("keeps a visible label for files grouped directly under the POSIX root", () => {
    const files = [
      fileItem({
        path: "/app.js",
        name: "app.js",
        directoryPath: "/"
      }),
      fileItem({
        path: "/index.html",
        name: "index.html",
        directoryPath: "/"
      })
    ];

    const presented = presentAgentGeneratedFileMentionItems({
      files,
      browsePath: null,
      query: ""
    });

    expect(presented[0]).toMatchObject({
      href: "/",
      name: "/",
      path: "/",
      entryKind: "directory",
      mentionNavigation: "agent-generated-folder",
      childCount: 2
    });
  });

  it("normalizes Windows generated directories into named folder rows", () => {
    const files = [
      fileItem({
        path: String.raw`C:\workspace\generated\report.md`,
        name: "report.md",
        directoryPath: String.raw`C:\workspace\generated`
      }),
      fileItem({
        path: String.raw`C:\workspace\generated\summary.md`,
        name: "summary.md",
        directoryPath: String.raw`C:\workspace\generated`
      })
    ];

    const presented = presentAgentGeneratedFileMentionItems({
      files,
      browsePath: null,
      query: ""
    });

    expect(presented[0]).toMatchObject({
      href: "C:/workspace/generated/",
      name: "generated",
      path: "C:/workspace/generated",
      entryKind: "directory",
      mentionNavigation: "agent-generated-folder",
      childCount: 2
    });
  });

  it("keeps a flat file list while searching", () => {
    const files = [
      fileItem({
        path: "/workspace/demo/static/app.js",
        name: "app.js",
        directoryPath: "/workspace/demo/static"
      }),
      fileItem({
        path: "/workspace/demo/static/index.html",
        name: "index.html",
        directoryPath: "/workspace/demo/static"
      })
    ];

    const presented = presentAgentGeneratedFileMentionItems({
      files,
      browsePath: null,
      query: "app"
    });

    expect(presented).toHaveLength(2);
    expect(
      presented.every((item) => item.kind === "file" && !item.mentionNavigation)
    ).toBe(true);
  });
});
