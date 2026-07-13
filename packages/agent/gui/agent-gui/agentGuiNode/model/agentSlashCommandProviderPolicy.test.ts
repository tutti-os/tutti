import { describe, expect, it } from "vitest";
import { resolveSlashCommandsForProvider } from "./agentSlashCommandProviderPolicy";

describe("compact capability gating", () => {
  const policy = {
    commandCatalogAuthoritative: true,
    commandEffects: [],
    fallbackCommands: ["compact", "status"]
  };

  it("keeps descriptor compact when capability is unknown", () => {
    const commands = resolveSlashCommandsForProvider({
      provider: "codex",
      commands: [{ name: "compact" }, { name: "status" }],
      policy
    });
    expect(commands.some((command) => command.name === "compact")).toBe(true);
  });

  it("keeps compact when capability resolves true", () => {
    const commands = resolveSlashCommandsForProvider({
      provider: "codex",
      commands: [{ name: "compact" }],
      compactSupported: true,
      policy
    });
    expect(commands.some((command) => command.name === "compact")).toBe(true);
  });

  it("drops compact (including fallback) when capability resolves false", () => {
    const commands = resolveSlashCommandsForProvider({
      provider: "codex",
      commands: [{ name: "compact" }, { name: "status" }],
      compactSupported: false,
      policy
    });
    expect(commands.some((command) => command.name === "compact")).toBe(false);
    expect(commands.some((command) => command.name === "status")).toBe(true);
  });
});
