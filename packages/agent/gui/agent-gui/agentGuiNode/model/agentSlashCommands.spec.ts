import { describe, expect, it } from "vitest";
import {
  draftForSlashCommand,
  filterSlashCommands,
  labelForSlashCommand,
  mergeSlashCommands,
  moveSlashCommandHighlight,
  parseSlashCommandInvocation,
  promptForSlashCommand
} from "./agentSlashCommands";

describe("agentSlashCommands", () => {
  it("filters by command name prefix and description substring", () => {
    const commands = [
      { name: "web", description: "Search online" },
      { name: "read", description: "Open files" },
      { name: "review", description: "Inspect changes" }
    ];

    expect(
      filterSlashCommands(commands, "re").map((command) => command.name)
    ).toEqual(["read", "review"]);
    expect(
      filterSlashCommands(commands, "online").map((command) => command.name)
    ).toEqual(["web"]);
  });

  it("wraps keyboard highlight movement and creates draft text", () => {
    expect(moveSlashCommandHighlight(0, 3, -1)).toBe(2);
    expect(moveSlashCommandHighlight(2, 3, 1)).toBe(0);
    expect(draftForSlashCommand({ name: " web " })).toBe("/web ");
    expect(draftForSlashCommand({ name: " web " }, "   /w")).toBe("   /web ");
  });

  it("merges provider commands before fallback commands and deduplicates by name", () => {
    expect(
      mergeSlashCommands(
        [
          { name: " compact ", description: "provider compact" },
          { name: "read" }
        ],
        [
          { name: "compact", description: "fallback compact" },
          { name: "status" }
        ]
      )
    ).toEqual([
      { name: "compact", description: "provider compact" },
      { name: "read" },
      { name: "status" }
    ]);
  });

  it("parses prompt-start slash command invocations with arguments", () => {
    expect(parseSlashCommandInvocation(" /plan refactor auth")).toEqual({
      args: "refactor auth",
      commandName: "plan",
      leadingWhitespace: " ",
      normalizedPrompt: "/plan refactor auth"
    });
    expect(parseSlashCommandInvocation("/compact")).toEqual({
      args: "",
      commandName: "compact",
      leadingWhitespace: "",
      normalizedPrompt: "/compact"
    });
    expect(parseSlashCommandInvocation("please /compact")).toBeNull();
  });

  it("creates prompt text for a slash command", () => {
    expect(promptForSlashCommand({ name: " init " })).toBe("/init");
  });

  it("creates display text for a slash command", () => {
    expect(labelForSlashCommand({ name: " compact " })).toBe("compact");
  });
});
