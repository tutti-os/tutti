import { describe, expect, it } from "vitest";
import { normalizeAgentTitleText } from "./agentTitleText";

describe("normalizeAgentTitleText", () => {
  it("returns empty string for null or undefined", () => {
    expect(normalizeAgentTitleText(null)).toBe("");
    expect(normalizeAgentTitleText(undefined)).toBe("");
  });

  it("returns trimmed value for plain text", () => {
    expect(normalizeAgentTitleText("  hello world  ")).toBe("hello world");
  });

  it("strips markdown link syntax and keeps the label", () => {
    expect(normalizeAgentTitleText("[click here](https://example.com)")).toBe(
      "click here"
    );
  });

  it("strips bold markers with double asterisks", () => {
    expect(normalizeAgentTitleText("**important** message")).toBe(
      "important message"
    );
  });

  it("strips bold markers with double underscores", () => {
    expect(normalizeAgentTitleText("__important__ message")).toBe(
      "important message"
    );
  });

  it("strips italic markers with single asterisks", () => {
    expect(normalizeAgentTitleText("*note* message")).toBe("note message");
  });

  it("strips italic markers with single underscores", () => {
    expect(normalizeAgentTitleText("_note_ message")).toBe("note message");
  });

  it("strips bold-italic triple asterisk markers", () => {
    expect(normalizeAgentTitleText("***important*** text")).toBe(
      "important text"
    );
  });

  it("does not strip single literal asterisk used as multiplication", () => {
    expect(normalizeAgentTitleText("2 * 3 = 6")).toBe("2 * 3 = 6");
  });

  it("collapses multiple whitespace into single space", () => {
    expect(normalizeAgentTitleText("hello\n\n  world")).toBe("hello world");
  });

  it("handles combined markdown links and bold markers", () => {
    expect(
      normalizeAgentTitleText("**See [docs](https://x.com)** for details")
    ).toBe("See docs for details");
  });
});
