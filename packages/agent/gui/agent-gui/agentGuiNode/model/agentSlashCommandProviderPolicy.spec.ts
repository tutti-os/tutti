import { describe, expect, it } from "vitest";
import {
  resolveSlashCommandsForProvider,
  resolveSlashCommandSelectionEffect,
  resolveSlashCommandSubmitEffect
} from "./agentSlashCommandProviderPolicy";

describe("agentSlashCommandProviderPolicy", () => {
  it("adds Codex compact and status fallback commands after provider commands", () => {
    expect(
      resolveSlashCommandsForProvider({
        provider: "codex",
        commands: [{ name: "web" }, { name: "compact", description: "ACP" }]
      })
    ).toEqual([
      { name: "web" },
      { name: "compact", description: "ACP" },
      { name: "status" },
      { name: "fast" }
    ]);
  });

  it("adds Claude Code fallback commands when ACP commands are empty", () => {
    expect(
      resolveSlashCommandsForProvider({
        provider: "claude-code",
        commands: []
      }).map((command) => command.name)
    ).toEqual(["compact", "status", "fast"]);
  });

  it("filters compact when the session has no compactable context", () => {
    expect(
      resolveSlashCommandsForProvider({
        provider: "codex",
        commands: [{ name: "compact", description: "from provider" }],
        hasCompactableContext: false
      })
    ).toEqual([{ name: "status" }, { name: "fast" }]);
  });

  it("filters Claude Code plan commands from provider and fallback commands", () => {
    expect(
      resolveSlashCommandsForProvider({
        provider: "claude-code",
        commands: [{ name: "plan", description: "provider plan" }]
      })
    ).toEqual([{ name: "compact" }, { name: "status" }, { name: "fast" }]);
  });

  it("submits Codex init and compact commands immediately", () => {
    expect(
      resolveSlashCommandSelectionEffect({
        provider: "codex",
        command: { name: "init" },
        currentDraft: "/"
      })
    ).toEqual({ kind: "submitPrompt", prompt: "/init" });
    expect(
      resolveSlashCommandSelectionEffect({
        provider: "codex",
        command: { name: " compact " },
        currentDraft: "/"
      })
    ).toEqual({ kind: "submitPrompt", prompt: "/compact" });
  });

  it("fills draft for non-immediate Codex commands", () => {
    expect(
      resolveSlashCommandSelectionEffect({
        provider: "codex",
        command: { name: "web" },
        currentDraft: "/"
      })
    ).toEqual({ kind: "fillDraft", draft: "/web " });
  });

  it("handles Codex local status without provider prompts", () => {
    expect(
      resolveSlashCommandSelectionEffect({
        provider: "codex",
        command: { name: "status" },
        currentDraft: "/sta"
      })
    ).toEqual({ kind: "showStatus" });
    expect(
      resolveSlashCommandSelectionEffect({
        provider: "codex",
        command: { name: "plan" },
        currentDraft: "/pla"
      })
    ).toEqual({ kind: "blockCommand" });
  });

  it("handles Claude Code local status without provider prompts", () => {
    expect(
      resolveSlashCommandSelectionEffect({
        provider: "claude-code",
        command: { name: "status" },
        currentDraft: "/sta"
      })
    ).toEqual({ kind: "showStatus" });
    expect(
      resolveSlashCommandSelectionEffect({
        provider: "claude-code",
        command: { name: "plan" },
        currentDraft: "/pla"
      })
    ).toEqual({ kind: "blockCommand" });
  });

  it("submits advertised Claude Code compact command as provider-native prompt", () => {
    expect(
      resolveSlashCommandSelectionEffect({
        provider: "claude-code",
        command: { name: "compact" },
        currentDraft: "/"
      })
    ).toEqual({ kind: "submitPrompt", prompt: "/compact" });
  });

  it("parses manual Codex status and blocks plan submissions", () => {
    const commands = resolveSlashCommandsForProvider({
      provider: "codex",
      commands: []
    });

    expect(
      resolveSlashCommandSubmitEffect({
        provider: "codex",
        commands,
        draft: "/status"
      })
    ).toEqual({ kind: "showStatus" });
    expect(
      resolveSlashCommandSubmitEffect({
        provider: "codex",
        commands,
        draft: "/plan"
      })
    ).toEqual({ kind: "blockCommand" });
  });

  it("parses manual Claude Code status and blocks plan submissions", () => {
    const commands = resolveSlashCommandsForProvider({
      provider: "claude-code",
      commands: []
    });

    expect(
      resolveSlashCommandSubmitEffect({
        provider: "claude-code",
        commands,
        draft: "/status"
      })
    ).toEqual({ kind: "showStatus" });
    expect(
      resolveSlashCommandSubmitEffect({
        provider: "claude-code",
        commands,
        draft: "/plan"
      })
    ).toEqual({ kind: "blockCommand" });
    expect(
      resolveSlashCommandSubmitEffect({
        provider: "claude-code",
        commands,
        draft: "/plan refactor auth"
      })
    ).toEqual({ kind: "blockCommand" });
  });

  it("keeps non-plan advertised Claude Code controls provider-native", () => {
    expect(
      resolveSlashCommandSubmitEffect({
        provider: "claude-code",
        commands: resolveSlashCommandsForProvider({
          provider: "claude-code",
          commands: [{ name: "context", description: "provider context" }]
        }),
        draft: "/context"
      })
    ).toEqual({ kind: "submitPrompt", prompt: "/context" });
  });

  it("does not intercept unknown slash text", () => {
    expect(
      resolveSlashCommandSubmitEffect({
        provider: "codex",
        commands: resolveSlashCommandsForProvider({
          provider: "codex",
          commands: []
        }),
        draft: "/unknown"
      })
    ).toBeNull();
  });
});
