import "@testing-library/jest-dom/vitest";
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AgentComposerHandoffIcon } from "./AgentComposerChrome";

describe("AgentComposerHandoffIcon", () => {
  it("keeps the static icon until the local hover animation loads", () => {
    const { container, rerender } = render(
      <AgentComposerHandoffIcon disabled={false} isPlaying={false} />
    );
    const icon = container.firstElementChild;

    expect(icon).not.toHaveAttribute("data-playing");
    expect(icon?.querySelector("img")).toBeNull();

    rerender(<AgentComposerHandoffIcon disabled={false} isPlaying />);

    const firstAnimation = icon?.querySelector("img");
    expect(icon).toHaveAttribute("data-playing", "true");
    expect(firstAnimation).not.toHaveAttribute("data-active");
    expect(firstAnimation?.getAttribute("src")).not.toMatch(/^https?:/);

    fireEvent.load(firstAnimation!);

    expect(firstAnimation).toHaveAttribute("data-active", "true");

    rerender(<AgentComposerHandoffIcon disabled={false} isPlaying={false} />);
    expect(icon?.querySelector("img")).toBeNull();

    rerender(<AgentComposerHandoffIcon disabled={false} isPlaying />);
    expect(icon?.querySelector("img")).not.toHaveAttribute("data-active");
  });
});
