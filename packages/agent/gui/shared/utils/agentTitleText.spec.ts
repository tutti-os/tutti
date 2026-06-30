import { describe, it, expect } from "vitest";

import { normalizeAgentTitleText } from "./agentTitleText";

describe("normalizeAgentTitleText", () => {
  it("strips bold markdown markers", () => {
    expect(normalizeAgentTitleText("**Important** task")).toBe(
      "Important task"
    );
  });

  it("strips italic markdown markers", () => {
    expect(normalizeAgentTitleText("Fix *urgent* bug")).toBe("Fix urgent bug");
  });

  it("strips inline code markers", () => {
    expect(normalizeAgentTitleText("Run `npm test`")).toBe("Run npm test");
  });

  it("strips markdown links", () => {
    expect(normalizeAgentTitleText("See [docs](https://example.com)")).toBe(
      "See docs"
    );
  });

  it("collapses whitespace", () => {
    expect(normalizeAgentTitleText("Multiple    spaces\n\nhere")).toBe(
      "Multiple spaces here"
    );
  });

  it("returns empty string for null or undefined", () => {
    expect(normalizeAgentTitleText(null)).toBe("");
    expect(normalizeAgentTitleText(undefined)).toBe("");
  });

  it("leaves plain text unchanged", () => {
    expect(normalizeAgentTitleText("Simple title")).toBe("Simple title");
  });
});
