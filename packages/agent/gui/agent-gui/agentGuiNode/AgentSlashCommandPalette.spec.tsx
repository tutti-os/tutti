import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AgentSlashCommandPalette } from "./AgentSlashCommandPalette";

describe("AgentSlashCommandPalette", () => {
  it("renders a capability loading row before any options arrive", () => {
    render(
      <AgentSlashCommandPalette
        label="Slash commands"
        commandsGroupLabel="Commands"
        capabilitiesGroupLabel="Capabilities"
        capabilitiesLoading
        capabilitiesLoadingLabel="Loading capabilities…"
        skillsGroupLabel="Skills"
        pluginsGroupLabel="Plugins"
        connectorsGroupLabel="Connectors"
        mcpGroupLabel="MCP"
        highlightedIndex={0}
        entries={[]}
        onHighlightChange={vi.fn()}
        onSelect={vi.fn()}
        onSelectCapability={vi.fn()}
        onSelectSkill={vi.fn()}
      />
    );

    expect(
      screen.getByRole("listbox", { name: "Slash commands" })
    ).toBeInTheDocument();
    expect(screen.getByText("Capabilities")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Loading capabilities…"
    );
    expect(screen.queryByRole("option")).toBeNull();
  });

  it("renders command options without input hints", () => {
    render(
      <AgentSlashCommandPalette
        label="Slash commands"
        commandsGroupLabel="Commands"
        capabilitiesGroupLabel="Capabilities"
        skillsGroupLabel="Skills"
        pluginsGroupLabel="Plugins"
        connectorsGroupLabel="Connectors"
        mcpGroupLabel="MCP"
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
    expect(palette).toBeInTheDocument();

    const option = screen.getByRole("option", { name: /tutti-cli/i });
    expect(option).toHaveAttribute("data-highlighted", "");
    expect(screen.getByText("tutti-cli")).toHaveClass("text-[13px]");
    expect(screen.getByText("Inspect tasks and agent context")).toHaveClass(
      "text-[13px]"
    );
    expect(
      screen.getByText("tutti-cli").parentElement?.parentElement
    ).toHaveClass("gap-[8px]");
    expect(screen.queryByText("[issue description]")).toBeNull();
  });

  it("removes terminal periods from every description", () => {
    render(
      <AgentSlashCommandPalette
        label="Slash commands"
        commandsGroupLabel="Commands"
        capabilitiesGroupLabel="Capabilities"
        skillsGroupLabel="Skills"
        pluginsGroupLabel="Plugins"
        connectorsGroupLabel="Connectors"
        mcpGroupLabel="MCP"
        highlightedIndex={0}
        entries={[
          {
            type: "command",
            key: "command:english",
            label: "english",
            description: "Keep internal e.g. punctuation.",
            command: { name: "english" }
          },
          {
            type: "command",
            key: "command:chinese",
            label: "chinese",
            description: "保留内部标点，移除末尾句号。",
            command: { name: "chinese" }
          }
        ]}
        onHighlightChange={vi.fn()}
        onSelect={vi.fn()}
        onSelectCapability={vi.fn()}
        onSelectSkill={vi.fn()}
      />
    );

    expect(screen.getByText("Keep internal e.g. punctuation")).toHaveClass(
      "text-[13px]"
    );
    expect(screen.getByText("保留内部标点，移除末尾句号")).toBeInTheDocument();
    expect(screen.queryByText("Keep internal e.g. punctuation.")).toBeNull();
    expect(screen.queryByText("保留内部标点，移除末尾句号。")).toBeNull();
  });

  it("renders a capability section and dispatches capability selection", () => {
    const onSelectCapability = vi.fn();

    render(
      <AgentSlashCommandPalette
        label="Slash commands"
        commandsGroupLabel="Commands"
        capabilitiesGroupLabel="Capabilities"
        skillsGroupLabel="Skills"
        pluginsGroupLabel="Plugins"
        connectorsGroupLabel="Connectors"
        mcpGroupLabel="MCP"
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
    expect(
      screen.getByRole("option", { name: /Browser/i }).querySelector("svg")
    ).toBeTruthy();
  });

  it("renders icons for built-in slash commands", () => {
    render(
      <AgentSlashCommandPalette
        label="Slash commands"
        commandsGroupLabel="Commands"
        capabilitiesGroupLabel="Capabilities"
        skillsGroupLabel="Skills"
        pluginsGroupLabel="Plugins"
        connectorsGroupLabel="Connectors"
        mcpGroupLabel="MCP"
        highlightedIndex={0}
        entries={[
          {
            type: "command",
            key: "command:compact",
            label: "compact",
            description: "Compact the conversation.",
            command: { name: "compact" }
          },
          {
            type: "command",
            key: "command:status",
            label: "status",
            description: "Show session status.",
            command: { name: "status" }
          }
        ]}
        onHighlightChange={vi.fn()}
        onSelect={vi.fn()}
        onSelectCapability={vi.fn()}
        onSelectSkill={vi.fn()}
      />
    );

    const compactIcon = screen
      .getByRole("option", { name: /compact/i })
      .querySelector("svg");
    expect(compactIcon).toBeTruthy();

    const icon = screen
      .getByRole("option", { name: /status/i })
      .querySelector("svg");
    expect(icon).toBeTruthy();
    // The svg carries its own size class so the option's
    // `[&_svg:not([class*='size-'])]:size-4` fallback does not override it.
    expect(icon).toHaveClass("size-4");
    expect(icon?.parentElement).toHaveClass(
      "flex",
      "w-4",
      "shrink-0",
      "items-center",
      "justify-center",
      "text-[var(--text-secondary)]"
    );
    expect(icon?.parentElement).not.toHaveClass(
      "bg-[var(--transparency-hover)]",
      "rounded-[7px]"
    );
  });

  it("renders a primary localized label with an English alias", () => {
    render(
      <AgentSlashCommandPalette
        label="Slash commands"
        commandsGroupLabel="Commands"
        capabilitiesGroupLabel="Capabilities"
        skillsGroupLabel="Skills"
        pluginsGroupLabel="Plugins"
        connectorsGroupLabel="Connectors"
        mcpGroupLabel="MCP"
        highlightedIndex={0}
        entries={[
          {
            type: "command",
            key: "command:status",
            label: "status",
            primaryLabel: "状态",
            secondaryLabel: "status",
            command: { name: "status" }
          }
        ]}
        onHighlightChange={vi.fn()}
        onSelect={vi.fn()}
        onSelectCapability={vi.fn()}
        onSelectSkill={vi.fn()}
      />
    );

    expect(screen.getByText("状态")).toBeInTheDocument();
    expect(screen.getByText("status")).toHaveClass(
      "text-[13px]",
      "font-normal",
      "text-[var(--text-secondary)]"
    );
    expect(screen.getByText("status").parentElement).toHaveClass("gap-[8px]");
  });

  it("uses distinct icons for plan and review commands", () => {
    render(
      <AgentSlashCommandPalette
        label="Slash commands"
        commandsGroupLabel="Commands"
        capabilitiesGroupLabel="Capabilities"
        skillsGroupLabel="Skills"
        pluginsGroupLabel="Plugins"
        connectorsGroupLabel="Connectors"
        mcpGroupLabel="MCP"
        highlightedIndex={0}
        entries={[
          {
            type: "command",
            key: "command:plan",
            label: "plan",
            command: { name: "plan" }
          },
          {
            type: "command",
            key: "command:review",
            label: "review",
            command: { name: "review" }
          }
        ]}
        onHighlightChange={vi.fn()}
        onSelect={vi.fn()}
        onSelectCapability={vi.fn()}
        onSelectSkill={vi.fn()}
      />
    );

    const planIcon = screen
      .getByRole("option", { name: /plan/i })
      .querySelector("svg");
    const reviewIcon = screen
      .getByRole("option", { name: /review/i })
      .querySelector("svg");

    expect(planIcon?.innerHTML).not.toBe(reviewIcon?.innerHTML);
  });

  it("renders inline settings on capability entries and dispatches settings selection", () => {
    const onSelectCapabilitySettings = vi.fn();

    render(
      <AgentSlashCommandPalette
        label="Slash commands"
        commandsGroupLabel="Commands"
        capabilitiesGroupLabel="Capabilities"
        skillsGroupLabel="Skills"
        pluginsGroupLabel="Plugins"
        connectorsGroupLabel="Connectors"
        mcpGroupLabel="MCP"
        highlightedIndex={0}
        entries={[
          {
            type: "capability",
            key: "capability:computerUse",
            label: "Computer",
            description: "Install or grant access.",
            settingsAriaLabel: "Computer use setup",
            settingsLabel: "Settings",
            capability: {
              kind: "capability",
              capability: "computerUse",
              name: "computer",
              aliases: ["电脑"]
            }
          }
        ]}
        onHighlightChange={vi.fn()}
        onSelect={vi.fn()}
        onSelectCapability={vi.fn()}
        onSelectCapabilitySettings={onSelectCapabilitySettings}
        onSelectSkill={vi.fn()}
      />
    );

    expect(screen.getByText("Capabilities")).toBeInTheDocument();
    screen.getByRole("button", { name: "Computer use setup" }).click();
    expect(onSelectCapabilitySettings).toHaveBeenCalledWith({
      kind: "capability",
      capability: "computerUse",
      name: "computer",
      aliases: ["电脑"]
    });
  });

  it("keeps a read-only capability visible without dispatching mutations", () => {
    const onSelectCapability = vi.fn();
    const onSelectCapabilitySettings = vi.fn();

    render(
      <AgentSlashCommandPalette
        label="Slash commands"
        commandsGroupLabel="Commands"
        capabilitiesGroupLabel="Capabilities"
        skillsGroupLabel="Skills"
        pluginsGroupLabel="Plugins"
        connectorsGroupLabel="Connectors"
        mcpGroupLabel="MCP"
        highlightedIndex={0}
        entries={[
          {
            type: "capability",
            key: "capability:computerUse",
            label: "Computer",
            disabled: true,
            settingsAriaLabel: "Computer use setup",
            settingsLabel: "Settings",
            capability: {
              kind: "capability",
              capability: "computerUse",
              name: "computer"
            }
          }
        ]}
        onHighlightChange={vi.fn()}
        onSelect={vi.fn()}
        onSelectCapability={onSelectCapability}
        onSelectCapabilitySettings={onSelectCapabilitySettings}
        onSelectSkill={vi.fn()}
      />
    );

    const capability = screen.getByRole("option", { name: /computer/i });
    expect(capability).toHaveAttribute("aria-disabled", "true");
    capability.click();
    screen.getByRole("button", { name: "Computer use setup" }).click();

    expect(onSelectCapability).not.toHaveBeenCalled();
    expect(onSelectCapabilitySettings).not.toHaveBeenCalled();
  });

  it("separates plugin and connector skill entries into source groups", () => {
    render(
      <AgentSlashCommandPalette
        label="Slash commands"
        commandsGroupLabel="Commands"
        capabilitiesGroupLabel="Capabilities"
        skillsGroupLabel="Skills"
        pluginsGroupLabel="Plugins"
        connectorsGroupLabel="Connectors"
        mcpGroupLabel="MCP"
        highlightedIndex={0}
        entries={[
          {
            type: "skill",
            key: "skill:plugin-review",
            label: "plugin-review",
            skill: {
              name: "plugin-review",
              trigger: "$plugin-review",
              sourceKind: "plugin",
              pluginName: "review-tools"
            }
          },
          {
            type: "skill",
            key: "skill:google-drive",
            label: "google-drive",
            skill: {
              name: "Google Drive",
              trigger: "$google-drive",
              sourceKind: "connector",
              kind: "connector"
            }
          }
        ]}
        onHighlightChange={vi.fn()}
        onSelect={vi.fn()}
        onSelectCapability={vi.fn()}
        onSelectSkill={vi.fn()}
      />
    );

    expect(screen.getByText("Plugins")).toBeInTheDocument();
    expect(screen.getByText("Connectors")).toHaveClass(
      "mt-3",
      "pt-3",
      "before:inset-x-3",
      "before:border-t",
      "before:border-[var(--border-1)]"
    );
    expect(screen.queryByText("Skills")).toBeNull();
  });
});
