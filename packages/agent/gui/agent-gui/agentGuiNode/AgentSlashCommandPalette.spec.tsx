import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AgentSlashCommandPalette } from "./AgentSlashCommandPalette";

describe("AgentSlashCommandPalette", () => {
  it("uses mention palette row spacing and color tokens for command options", () => {
    render(
      <AgentSlashCommandPalette
        label="Slash commands"
        commandsGroupLabel="Commands"
        capabilitiesGroupLabel="Capabilities"
        skillsGroupLabel="Skills"
        highlightedIndex={0}
        entries={[
          {
            type: "command",
            key: "command:tutti-cli",
            label: "tutti-cli",
            description: "Inspect tasks and agent context.",
            command: {
              name: "tutti-cli",
              description: "Inspect tasks and agent context.",
              inputHint: "[issue description]"
            }
          }
        ]}
        onHighlightChange={vi.fn()}
        onSelect={vi.fn()}
        onSelectCapability={vi.fn()}
        onSelectSkill={vi.fn()}
      />
    );

    const palette = screen.getByRole("listbox", { name: "Slash commands" });
    expect(palette).toHaveClass(
      "agent-gui-node__mention-palette",
      "px-1",
      "pb-1",
      "pt-2"
    );

    const option = screen.getByRole("option", { name: /tutti-cli/i });
    expect(option).toHaveClass(
      "rounded-[6px]",
      "min-h-9",
      "px-2.5",
      "py-2",
      "data-[highlighted]:bg-[var(--transparency-block)]",
      "active:bg-[var(--transparency-active)]"
    );
    expect(option).not.toHaveClass(
      "hover:bg-[var(--transparency-block)]",
      "focus:bg-[var(--transparency-block)]"
    );
    expect(option).toHaveAttribute("data-highlighted", "");
    expect(screen.getByText("tutti-cli")).toHaveClass(
      "max-w-[48%]",
      "shrink-0",
      "truncate",
      "text-[11px]"
    );
    expect(screen.getByText("Inspect tasks and agent context.")).toHaveClass(
      "flex-1",
      "truncate",
      "text-[11px]",
      "text-[var(--text-secondary)]"
    );
    expect(screen.queryByText("[issue description]")).toBeNull();
  });

  it("renders a capability section and dispatches capability selection", () => {
    const onSelectCapability = vi.fn();

    render(
      <AgentSlashCommandPalette
        label="Slash commands"
        commandsGroupLabel="Commands"
        capabilitiesGroupLabel="Capabilities"
        skillsGroupLabel="Skills"
        highlightedIndex={0}
        entries={[
          {
            type: "capability",
            key: "capability:browserUse",
            label: "Browser",
            description: "Let the agent use a browser.",
            capability: {
              kind: "capability",
              capability: "browserUse",
              name: "browser",
              aliases: ["浏览器"]
            }
          }
        ]}
        onHighlightChange={vi.fn()}
        onSelect={vi.fn()}
        onSelectCapability={onSelectCapability}
        onSelectSkill={vi.fn()}
      />
    );

    expect(screen.getByText("Capabilities")).toBeInTheDocument();
    screen.getByRole("option", { name: /Browser/i }).click();
    expect(onSelectCapability).toHaveBeenCalledWith({
      kind: "capability",
      capability: "browserUse",
      name: "browser",
      aliases: ["浏览器"]
    });
  });
});
