import { describe, expect, it } from "vitest";
import { stripMarkdownFormatting } from "./markdownPlainText";

describe("stripMarkdownFormatting", () => {
  it("strips bold markers", () => {
    expect(stripMarkdownFormatting("**bold text**")).toBe("bold text");
    expect(stripMarkdownFormatting("__bold text__")).toBe("bold text");
  });

  it("strips italic markers", () => {
    expect(stripMarkdownFormatting("*italic text*")).toBe("italic text");
  });

  it("strips bold+italic combos", () => {
    expect(stripMarkdownFormatting("***bold italic***")).toBe("bold italic");
  });

  it("strips inline code", () => {
    expect(stripMarkdownFormatting("`code`")).toBe("code");
    expect(stripMarkdownFormatting("``code``")).toBe("code");
  });

  it("strips strikethrough", () => {
    expect(stripMarkdownFormatting("~~struck~~")).toBe("struck");
  });

  it("converts links to label only", () => {
    expect(stripMarkdownFormatting("[link text](https://example.com)")).toBe(
      "link text"
    );
  });

  it("converts images to alt text", () => {
    expect(
      stripMarkdownFormatting("![alt text](https://example.com/img.png)")
    ).toBe("alt text");
  });

  it("strips heading markers", () => {
    expect(stripMarkdownFormatting("# Heading")).toBe("Heading");
    expect(stripMarkdownFormatting("### Sub Heading")).toBe("Sub Heading");
  });

  it("strips list markers", () => {
    expect(stripMarkdownFormatting("- item")).toBe("item");
    expect(stripMarkdownFormatting("* item")).toBe("item");
    expect(stripMarkdownFormatting("1. item")).toBe("item");
  });

  it("strips blockquote markers", () => {
    expect(stripMarkdownFormatting("> quoted text")).toBe("quoted text");
  });

  it("handles mixed content", () => {
    const input =
      "**Important:** Please review [the docs](https://example.com) and `config.json`.";
    const result = stripMarkdownFormatting(input);
    expect(result).toBe("Important: Please review the docs and config.json.");
  });

  it("preserves plain text", () => {
    expect(stripMarkdownFormatting("Just plain text.")).toBe(
      "Just plain text."
    );
  });

  it("handles empty string", () => {
    expect(stripMarkdownFormatting("")).toBe("");
  });

  it("does not strip underscores in file paths", () => {
    expect(stripMarkdownFormatting("/path/to/my_file_name.ts")).toBe(
      "/path/to/my_file_name.ts"
    );
  });
});
