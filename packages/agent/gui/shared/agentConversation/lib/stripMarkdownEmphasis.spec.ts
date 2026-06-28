import { describe, expect, it } from "vitest";
import { stripMarkdownEmphasis } from "./stripMarkdownEmphasis";

describe("stripMarkdownEmphasis", () => {
  it("removes **bold** markers", () => {
    expect(stripMarkdownEmphasis("This is **important** text.")).toBe(
      "This is important text."
    );
  });

  it("removes *italic* markers", () => {
    expect(stripMarkdownEmphasis("This is *noted* text.")).toBe(
      "This is noted text."
    );
  });

  it("removes ***bold italic*** markers", () => {
    expect(stripMarkdownEmphasis("This is ***very important*** text.")).toBe(
      "This is very important text."
    );
  });

  it("removes __bold__ markers", () => {
    expect(stripMarkdownEmphasis("This is __underlined__ text.")).toBe(
      "This is underlined text."
    );
  });

  it("removes _italic_ markers between word boundaries", () => {
    expect(stripMarkdownEmphasis("The _quick_ fox")).toBe("The quick fox");
  });

  it("strips bold markers from Chinese text (the reported issue)", () => {
    expect(stripMarkdownEmphasis("**3 号线也不是最优**")).toBe(
      "3 号线也不是最优"
    );
    expect(
      stripMarkdownEmphasis("**福田站坐 11 号线 → 南山站下 → E2 出口步行过去**")
    ).toBe("福田站坐 11 号线 → 南山站下 → E2 出口步行过去");
  });

  it("handles multiple emphasis in one string", () => {
    expect(stripMarkdownEmphasis("**bold** and *italic* and __more__")).toBe(
      "bold and italic and more"
    );
  });

  it("preserves inline code spans", () => {
    expect(stripMarkdownEmphasis("Run `git commit **not bold**` now")).toBe(
      "Run `git commit **not bold**` now"
    );
  });

  it("preserves fenced code blocks", () => {
    const text = "Here:\n```js\nconst x = '**value**';\n```\nDone.";
    expect(stripMarkdownEmphasis(text)).toBe(text);
  });

  it("strips emphasis outside code but preserves it inside", () => {
    expect(stripMarkdownEmphasis("**bold** and `code *not italic*`")).toBe(
      "bold and `code *not italic*`"
    );
  });

  it("leaves unmatched asterisks alone", () => {
    expect(stripMarkdownEmphasis("Use * for bullets")).toBe(
      "Use * for bullets"
    );
  });

  it("leaves snake_case identifiers alone", () => {
    expect(stripMarkdownEmphasis("my_variable_name")).toBe("my_variable_name");
  });

  it("returns plain text unchanged", () => {
    expect(stripMarkdownEmphasis("No markdown here.")).toBe(
      "No markdown here."
    );
  });
});
