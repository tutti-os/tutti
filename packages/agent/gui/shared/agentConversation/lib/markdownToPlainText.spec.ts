import { describe, it, expect } from "vitest";

import { markdownToPlainText } from "./markdownToPlainText";

describe("markdownToPlainText", () => {
  it("leaves plain text unchanged", () => {
    expect(markdownToPlainText("Hello world")).toBe("Hello world");
  });

  it("strips bold markers", () => {
    expect(markdownToPlainText("This is **bold** text")).toBe(
      "This is bold text"
    );
  });

  it("strips italic markers", () => {
    expect(markdownToPlainText("This is *italic* text")).toBe(
      "This is italic text"
    );
  });

  it("strips bold underscore markers", () => {
    expect(markdownToPlainText("This is __bold__ text")).toBe(
      "This is bold text"
    );
  });

  it("strips inline code backticks", () => {
    expect(markdownToPlainText("Run `npm install` now")).toBe(
      "Run npm install now"
    );
  });

  it("strips strikethrough markers", () => {
    expect(markdownToPlainText("This is ~~old~~ text")).toBe(
      "This is old text"
    );
  });

  it("converts links to just the link text", () => {
    expect(markdownToPlainText("See [the docs](https://example.com)")).toBe(
      "See the docs"
    );
  });

  it("converts images to just the alt text", () => {
    expect(markdownToPlainText("![logo](https://example.com/logo.png)")).toBe(
      "logo"
    );
  });

  it("strips heading markers", () => {
    expect(markdownToPlainText("## Section Title\nSome body")).toBe(
      "Section Title\nSome body"
    );
  });

  it("removes code fence markers but keeps content", () => {
    const input = "Here is code:\n```ts\nconst x = 1;\n```\nDone.";
    const result = markdownToPlainText(input);
    expect(result).toBe("Here is code:\nconst x = 1;\nDone.");
  });

  it("handles multiple formatting markers in one string", () => {
    expect(
      markdownToPlainText(
        "**Bold** and *italic* and `code` and ~~strike~~ and [link](url)"
      )
    ).toBe("Bold and italic and code and strike and link");
  });

  it("does not modify snake_case identifiers", () => {
    expect(markdownToPlainText("use my_variable_name here")).toBe(
      "use my_variable_name here"
    );
  });

  it("handles nested bold inside italic gracefully", () => {
    expect(markdownToPlainText("**bold** remaining")).toBe("bold remaining");
  });
});
