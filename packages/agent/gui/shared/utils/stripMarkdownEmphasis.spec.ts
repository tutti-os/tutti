import { describe, it, expect } from "vitest";
import { stripMarkdownEmphasis } from "./stripMarkdownEmphasis";

describe("stripMarkdownEmphasis", () => {
  it("strips bold markers (**)", () => {
    expect(stripMarkdownEmphasis("**hello**")).toBe("hello");
  });

  it("strips bold markers (__)", () => {
    expect(stripMarkdownEmphasis("__hello__")).toBe("hello");
  });

  it("strips italic markers (*)", () => {
    expect(stripMarkdownEmphasis("*hello*")).toBe("hello");
  });

  it("strips italic markers (_)", () => {
    expect(stripMarkdownEmphasis("_hello_")).toBe("hello");
  });

  it("strips strikethrough markers (~~)", () => {
    expect(stripMarkdownEmphasis("~~hello~~")).toBe("hello");
  });

  it("strips inline code markers (`)", () => {
    expect(stripMarkdownEmphasis("`hello`")).toBe("hello");
  });

  it("strips bold-italic markers (***)", () => {
    expect(stripMarkdownEmphasis("***hello***")).toBe("hello");
  });

  it("handles mixed emphasis in a sentence", () => {
    expect(stripMarkdownEmphasis("This is **bold** and *italic* text.")).toBe(
      "This is bold and italic text."
    );
  });

  it("does not strip unpaired markers", () => {
    expect(stripMarkdownEmphasis("5 * 3 = 15")).toBe("5 * 3 = 15");
  });

  it("does not strip lone asterisks", () => {
    expect(stripMarkdownEmphasis("This is not **bold")).toBe(
      "This is not **bold"
    );
  });

  it("preserves text without emphasis", () => {
    expect(stripMarkdownEmphasis("Hello world")).toBe("Hello world");
  });

  it("handles empty string", () => {
    expect(stripMarkdownEmphasis("")).toBe("");
  });

  it("handles multiple emphasis in sequence", () => {
    expect(
      stripMarkdownEmphasis("**bold** and _italic_ and `code`")
    ).toBe("bold and italic and code");
  });
});
