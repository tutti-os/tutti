import { describe, expect, it } from "vitest";
import { parseRichTextMentionHref } from "@tutti-os/ui-rich-text/core";
import {
  browserElementMentionLabel,
  createBrowserElementMentionMarkdown,
  presentBrowserElementMention
} from "./browserElementMention.ts";

describe("browser element mentions", () => {
  it("preserve prompt text and show only the DOM tag", () => {
    const context = [
      "DOM Path: #app > div",
      "Position: top=0px",
      "HTML Element: <div>Hello</div>"
    ].join("\n");
    const markdown = createBrowserElementMentionMarkdown({
      context,
      id: "browser-element:1",
      tagName: "A",
      workspaceId: "workspace-1"
    });
    const href = markdown.slice(markdown.indexOf("(") + 1, -1);
    const mention = parseRichTextMentionHref(href);

    expect(markdown).toMatch(/^\[@a\]\(/u);
    expect(browserElementMentionLabel(mention?.scope?.tag ?? "")).toBe("<a>");
    expect(mention?.providerId).toBe("browser-element");
    expect(mention?.scope?.context).toBe(context);
    expect(mention?.scope?.workspaceId).toBe("workspace-1");
  });

  it("reject incomplete references", () => {
    expect(
      createBrowserElementMentionMarkdown({
        context: "",
        id: "browser-element:1",
        tagName: "div",
        workspaceId: "workspace-1"
      })
    ).toBe("");
  });

  it("keep historical references presentable without inline context", () => {
    expect(
      presentBrowserElementMention({
        label: "a",
        scope: { tag: "a", workspaceId: "workspace-1" }
      })
    ).toEqual({ name: "<a>", workspaceId: "workspace-1" });
  });
});
