import { describe, expect, it } from "vitest";
import {
  isAgentGUIOpenTerminalShortcut,
  resolveAgentGUITerminalShortcutCwd,
  supportsAgentGUIOpenTerminalShortcut
} from "./agentGuiTerminalShortcut";

describe("agent GUI terminal shortcut", () => {
  it("accepts Cmd+J without extra modifiers", () => {
    expect(isAgentGUIOpenTerminalShortcut({ key: "j", metaKey: true })).toBe(
      true
    );
    expect(isAgentGUIOpenTerminalShortcut({ key: "J", metaKey: true })).toBe(
      true
    );
  });

  it("rejects handled or modified shortcut events", () => {
    expect(
      isAgentGUIOpenTerminalShortcut({
        defaultPrevented: true,
        key: "j",
        metaKey: true
      })
    ).toBe(false);
    expect(
      isAgentGUIOpenTerminalShortcut({
        key: "j",
        metaKey: true,
        shiftKey: true
      })
    ).toBe(false);
    expect(isAgentGUIOpenTerminalShortcut({ key: "j" })).toBe(false);
  });

  it("limits the shortcut to Codex and Claude Code providers", () => {
    expect(supportsAgentGUIOpenTerminalShortcut("codex")).toBe(true);
    expect(supportsAgentGUIOpenTerminalShortcut("claude-code")).toBe(true);
    expect(supportsAgentGUIOpenTerminalShortcut("gemini")).toBe(false);
  });

  it("resolves cwd from session, selected project, then fallback", () => {
    expect(
      resolveAgentGUITerminalShortcutCwd({
        activeConversationCwd: " /repo/session ",
        selectedProjectPath: "/repo/project",
        fallbackCwd: "/Users/local"
      })
    ).toBe("/repo/session");
    expect(
      resolveAgentGUITerminalShortcutCwd({
        activeConversationCwd: " ",
        selectedProjectPath: "/repo/project",
        fallbackCwd: "/Users/local"
      })
    ).toBe("/repo/project");
    expect(
      resolveAgentGUITerminalShortcutCwd({
        selectedProjectPath: "",
        fallbackCwd: "/Users/local"
      })
    ).toBe("/Users/local");
    expect(resolveAgentGUITerminalShortcutCwd({})).toBe("~");
  });
});
