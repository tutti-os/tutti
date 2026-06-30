import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AgentPathTailLabel } from "./AgentPathTailLabel";

describe("AgentPathTailLabel", () => {
  it("splits a path so the directory can shrink before the file name", () => {
    render(
      <AgentPathTailLabel
        path="/workspace/very/deep/path/manifest.json"
        fallback="File"
      />
    );

    const label = screen.getByTitle("/workspace/very/deep/path/manifest.json");
    const directory = label.querySelector(".agent-path-tail-label__directory");
    const fileName = label.querySelector(".agent-path-tail-label__file");

    expect(label.className).toContain("agent-path-tail-label");
    expect(directory?.textContent).toBe("/workspace/very/deep/path/");
    expect(fileName?.textContent).toBe("manifest.json");
  });

  it("renders unsplittable labels as the file segment", () => {
    render(<AgentPathTailLabel path={null} fallback="Code" />);

    const fileName = screen.getByText("Code");

    expect(fileName.className).toContain("agent-path-tail-label__file");
    expect(
      fileName.closest(".agent-path-tail-label")?.getAttribute("title")
    ).toBeNull();
  });
});
