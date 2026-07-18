import { describe, expect, it } from "vitest";
import { renderAgentConversationCopyHtml } from "./agentConversationCopyHtml";

describe("renderAgentConversationCopyHtml", () => {
  it("renders headings, paragraphs, lists and GFM tables", () => {
    const html = renderAgentConversationCopyHtml(
      [
        "# Session title",
        "",
        "Hello **world**",
        "",
        "- item one",
        "- item two",
        "",
        "| a | b |",
        "| - | - |",
        "| 1 | 2 |"
      ].join("\n")
    );

    expect(html).toContain("<h1>Session title</h1>");
    expect(html).toContain("<strong>world</strong>");
    expect(html).toContain("<li>item one</li>");
    expect(html).toContain("<table>");
    expect(html).toContain("<td>1</td>");
  });

  it("keeps inline data-URI images as real img sources", () => {
    const html = renderAgentConversationCopyHtml(
      "![shot.png](<data:image/png;base64,QUFB>)"
    );

    expect(html).toContain(
      '<img src="data:image/png;base64,QUFB" alt="shot.png"'
    );
  });

  it("sanitizes non-image protocols and ignores raw HTML", () => {
    const html = renderAgentConversationCopyHtml(
      [
        "<script>alert(1)</script>",
        "",
        "[link](javascript:alert(1))",
        "",
        "![x](<data:text/html;base64,QUFB>)"
      ].join("\n")
    );

    expect(html).not.toContain("<script>");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("data:text/html");
  });

  it("strips data:image/svg+xml even though it starts with data:image/", () => {
    const html = renderAgentConversationCopyHtml(
      "![x](<data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+>)"
    );

    expect(html).not.toContain("data:image/svg+xml");
  });

  it("keeps common raster data-URI subtypes", () => {
    for (const mime of ["image/jpeg", "image/jpg", "image/gif", "image/webp"]) {
      const html = renderAgentConversationCopyHtml(
        `![x](<data:${mime};base64,QUFB>)`
      );
      expect(html).toContain(`data:${mime};base64,QUFB`);
    }
  });
});
