import { describe, expect, it } from "vitest";
import {
  resolveSlashCommandsForProvider,
  resolveSlashCommandSelectionEffect,
  resolveSlashCommandSubmitEffect,
  resolveTuttiBrowserUseSubmitEffect
} from "./agentSlashCommandProviderPolicy";

describe("agentSlashCommandProviderPolicy", () => {
  const reviewPickerProviders = ["codex", "claude-code"] as const;

  it("adds browser-use as a composer capability when browser use is supported", () => {
    const commands = resolveSlashCommandsForProvider({
      provider: "codex",
      commands: [],
      browserSupported: true
    });

    expect(
      commands.find(
        (command) => "kind" in command && command.kind === "capability"
      )
    ).toEqual({
      kind: "capability",
      capability: "browserUse",
      name: "browser",
      aliases: ["浏览器"]
    });
  });

  it("fills a canonical browser token from Chinese and English slash capability names", () => {
    const commands = resolveSlashCommandsForProvider({
      provider: "codex",
      commands: [],
      browserSupported: true
    });

    expect(
      resolveSlashCommandSelectionEffect({
        provider: "codex",
        command: commands.find((command) => command.name === "browser")!,
        currentDraft: "/浏览"
      })
    ).toEqual({ kind: "enableBrowserUse", draft: "/browser " });
    expect(
      resolveSlashCommandSubmitEffect({
        provider: "codex",
        commands,
        draft: "/浏览器"
      })
    ).toBeNull();
    expect(
      resolveTuttiBrowserUseSubmitEffect({
        browserSupported: true,
        commands,
        draft: "/browser"
      })
    ).toEqual({
      kind: "submitPrompt",
      prompt: expect.stringContaining("browser-use"),
      displayPrompt: "/browser",
      enableBrowserUse: true
    });
    expect(
      resolveTuttiBrowserUseSubmitEffect({
        browserSupported: true,
        commands,
        draft: "$browser 帮我访问下 google.com"
      })
    ).toEqual({
      kind: "submitPrompt",
      prompt: expect.stringContaining("帮我访问下 google.com"),
      displayPrompt: "/browser 帮我访问下 google.com",
      enableBrowserUse: true
    });
    expect(
      resolveTuttiBrowserUseSubmitEffect({
        browserSupported: false,
        commands,
        draft: "$browser test"
      })
    ).toBeNull();
  });

  it("adds Codex compact, status, fast, goal, and review fallback commands after provider commands", () => {
    expect(
      resolveSlashCommandsForProvider({
        provider: "codex",
        commands: [{ name: "web" }, { name: "compact", description: "ACP" }]
      })
    ).toEqual([
      { name: "web" },
      { name: "compact", description: "ACP" },
      { name: "status" },
      { name: "fast" },
      { name: "goal" },
      { name: "review" }
    ]);
  });

  it("adds Claude Code fallback commands including goal when ACP commands are empty", () => {
    expect(
      resolveSlashCommandsForProvider({
        provider: "claude-code",
        commands: []
      }).map((command) => command.name)
    ).toEqual(["compact", "status", "fast", "goal", "review"]);
  });

  it("keeps noisy Claude Code discovered commands out of the slash palette", () => {
    expect(
      resolveSlashCommandsForProvider({
        provider: "claude-code",
        commands: [
          { name: "browser-use-tutti-10" },
          { name: "lark-mail" },
          { name: "context", description: "Show context" },
          { name: "goal" },
          { name: "security-review" },
          { name: "usage" }
        ]
      }).map((command) => command.name)
    ).toEqual([
      "context",
      "goal",
      "usage",
      "compact",
      "status",
      "fast",
      "review"
    ]);
  });

  it("filters compact when the session has no compactable context", () => {
    expect(
      resolveSlashCommandsForProvider({
        provider: "codex",
        commands: [{ name: "compact", description: "from provider" }],
        hasCompactableContext: false
      })
    ).toEqual([
      { name: "status" },
      { name: "fast" },
      { name: "goal" },
      { name: "review" }
    ]);
  });

  it("filters Claude Code plan commands from provider and fallback commands", () => {
    expect(
      resolveSlashCommandsForProvider({
        provider: "claude-code",
        commands: [{ name: "plan", description: "provider plan" }]
      })
    ).toEqual([
      { name: "compact" },
      { name: "status" },
      { name: "fast" },
      { name: "goal" },
      { name: "review" }
    ]);
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

  it("activates goal mode instead of filling a raw /goal draft", () => {
    expect(
      resolveSlashCommandSelectionEffect({
        provider: "codex",
        command: { name: "web" },
        currentDraft: "/"
      })
    ).toEqual({ kind: "fillDraft", draft: "/web " });
    expect(
      resolveSlashCommandSelectionEffect({
        provider: "codex",
        command: { name: "goal" },
        currentDraft: "/"
      })
    ).toEqual({ kind: "activateGoalMode" });
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
    ).toEqual({ kind: "togglePlanMode" });
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
    ).toEqual({ kind: "togglePlanMode" });
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

  it("activates goal mode for Claude Code goal command selection", () => {
    expect(
      resolveSlashCommandSelectionEffect({
        provider: "claude-code",
        command: { name: "goal" },
        currentDraft: "/"
      })
    ).toEqual({ kind: "activateGoalMode" });
  });

  it("parses manual Codex status and toggles plan mode on submit", () => {
    const commands = resolveSlashCommandsForProvider({
      provider: "codex",
      commands: [],
      planSupported: true
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
    ).toEqual({ kind: "togglePlanMode" });
  });

  it("parses manual Claude Code status and toggles plan mode on submit", () => {
    const commands = resolveSlashCommandsForProvider({
      provider: "claude-code",
      commands: [],
      planSupported: true
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
    ).toEqual({ kind: "togglePlanMode" });
    expect(
      resolveSlashCommandSubmitEffect({
        provider: "claude-code",
        commands,
        draft: "/plan refactor auth"
      })
    ).toEqual({ kind: "togglePlanMode" });
  });

  it("surfaces /plan only when plan mode is supported", () => {
    expect(
      resolveSlashCommandsForProvider({
        provider: "codex",
        commands: [{ name: "plan" }],
        planSupported: false
      }).some((command) => command.name === "plan")
    ).toBe(false);
    expect(
      resolveSlashCommandsForProvider({
        provider: "codex",
        commands: [],
        planSupported: true
      }).filter((command) => command.name === "plan")
    ).toHaveLength(1);
  });

  it("surfaces only /plan for Cursor and hides agent-advertised slash commands", () => {
    expect(
      resolveSlashCommandsForProvider({
        provider: "cursor",
        commands: [
          { name: "compact" },
          { name: "goal" },
          { name: "review" },
          { name: "browser-use-tutti-10" }
        ],
        planSupported: true
      }).map((command) => command.name)
    ).toEqual(["plan"]);
    expect(
      resolveSlashCommandsForProvider({
        provider: "cursor",
        commands: [{ name: "plan", description: "provider plan" }],
        planSupported: false
      })
    ).toEqual([]);
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

  it.each(reviewPickerProviders)(
    "opens the review picker when picking %s /review from the palette",
    (provider) => {
      expect(
        resolveSlashCommandSelectionEffect({
          provider,
          command: { name: "review", description: "Review code changes" },
          currentDraft: "/rev"
        })
      ).toEqual({ kind: "showReviewPicker" });
    }
  );

  it.each(reviewPickerProviders)(
    "opens the review picker when submitting bare /review on %s",
    (provider) => {
      const commands = resolveSlashCommandsForProvider({
        provider,
        commands: [{ name: "review", description: "Review code changes" }]
      });
      expect(
        resolveSlashCommandSubmitEffect({
          provider,
          commands,
          draft: "/review"
        })
      ).toEqual({ kind: "showReviewPicker" });
    }
  );

  it.each(reviewPickerProviders)(
    "opens the review picker from %s fallback /review before provider commands arrive",
    (provider) => {
      const commands = resolveSlashCommandsForProvider({
        provider,
        commands: [],
        hasCompactableContext: false
      });
      expect(commands.map((command) => command.name)).toContain("review");
      expect(
        resolveSlashCommandSubmitEffect({
          provider,
          commands,
          draft: "/review"
        })
      ).toEqual({ kind: "showReviewPicker" });
    }
  );

  it.each(reviewPickerProviders)(
    "submits /review <text> straight through as a %s custom review",
    (provider) => {
      const commands = resolveSlashCommandsForProvider({
        provider,
        commands: [{ name: "review", description: "Review code changes" }]
      });
      expect(
        resolveSlashCommandSubmitEffect({
          provider,
          commands,
          draft: "/review check the auth flow"
        })
      ).toBeNull();
    }
  );

  it("does not open the review picker for unknown providers", () => {
    expect(
      resolveSlashCommandSelectionEffect({
        provider: "other-provider",
        command: { name: "review", description: "Review" },
        currentDraft: "/rev"
      })
    ).toEqual({ kind: "fillDraft", draft: "/review " });
  });
});
