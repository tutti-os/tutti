import { describe, expect, it } from "vitest";
import { stripMarkdownForCopy } from "./stripMarkdownForCopy";

describe("stripMarkdownForCopy", () => {
  it("passes through plain text unchanged", () => {
    expect(stripMarkdownForCopy("Hello world")).toBe("Hello world");
  });

  it("strips bold markers", () => {
    expect(stripMarkdownForCopy("**bold text**")).toBe("bold text");
  });

  it("strips bold alt markers", () => {
    expect(stripMarkdownForCopy("__bold text__")).toBe("bold text");
  });

  it("strips italic markers", () => {
    expect(stripMarkdownForCopy("*italic text*")).toBe("italic text");
  });

  it("strips bold-italic markers", () => {
    expect(stripMarkdownForCopy("***bold italic***")).toBe("bold italic");
  });

  it("strips strikethrough markers", () => {
    expect(stripMarkdownForCopy("~~deleted~~")).toBe("deleted");
  });

  it("strips inline code markers", () => {
    expect(stripMarkdownForCopy("`code`")).toBe("code");
  });

  it("unwraps link labels", () => {
    expect(stripMarkdownForCopy("[label](https://example.com)")).toBe("label");
  });

  it("unwraps image alt text", () => {
    expect(stripMarkdownForCopy("![alt text](image.png)")).toBe("alt text");
  });

  it("strips fenced code block markers", () => {
    const input = "```js\nconst x = 1;\n```\nAfter";
    expect(stripMarkdownForCopy(input)).toBe("const x = 1;\nAfter");
  });

  it("strips heading markers", () => {
    expect(stripMarkdownForCopy("# Heading 1")).toBe("Heading 1");
    expect(stripMarkdownForCopy("### Heading 3")).toBe("Heading 3");
  });

  it("strips unordered list markers", () => {
    expect(stripMarkdownForCopy("- item one\n- item two")).toBe(
      "item one\nitem two"
    );
  });

  it("strips ordered list markers", () => {
    expect(stripMarkdownForCopy("1. first\n2. second")).toBe("first\nsecond");
  });

  it("strips blockquote markers", () => {
    expect(stripMarkdownForCopy("> quoted text")).toBe("quoted text");
  });

  it("strips horizontal rules", () => {
    expect(stripMarkdownForCopy("before\n---\nafter")).toBe("before\n\nafter");
  });

  it("handles mixed content with bold and links", () => {
    const input =
      "This is **important** and see [docs](https://docs.example.com).";
    expect(stripMarkdownForCopy(input)).toBe("This is important and see docs.");
  });

  it("preserves word-internal underscores", () => {
    expect(stripMarkdownForCopy("file_name_here")).toBe("file_name_here");
  });

  it("does not strip list-bullet asterisks as italic", () => {
    const input = "* item\n* another";
    expect(stripMarkdownForCopy(input)).toBe("item\nanother");
  });

  it("handles Chinese text with bold markers (issue #432 scenario)", () => {
    const input =
      "**3 号线也不是最优**\n\n**福田站坐 11 号线 → 南山站下 → E2 出口步行过去**";
    expect(stripMarkdownForCopy(input)).toBe(
      "3 号线也不是最优\n\n福田站坐 11 号线 → 南山站下 → E2 出口步行过去"
    );
  });

  it("strips unmatched bold markers (stray ** without closing pair)", () => {
    expect(stripMarkdownForCopy("Hello **World")).toBe("Hello World");
    expect(stripMarkdownForCopy("**unmatched text")).toBe("unmatched text");
  });

  it("strips unmatched underscore bold markers (stray __ without closing pair)", () => {
    expect(stripMarkdownForCopy("Hello __World")).toBe("Hello World");
  });

  it("handles multiple formatting in a single paragraph", () => {
    const input = "Use **bold** and *italic* and `code` together.";
    expect(stripMarkdownForCopy(input)).toBe(
      "Use bold and italic and code together."
    );
  });
});
