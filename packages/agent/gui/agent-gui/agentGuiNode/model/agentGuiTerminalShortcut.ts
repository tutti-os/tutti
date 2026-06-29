import type { AgentGUIProvider } from "../../../types";

export interface AgentGUITerminalShortcutEventLike {
  altKey?: boolean;
  ctrlKey?: boolean;
  defaultPrevented?: boolean;
  key: string;
  metaKey?: boolean;
  shiftKey?: boolean;
}

export function isAgentGUIOpenTerminalShortcut(
  event: AgentGUITerminalShortcutEventLike
): boolean {
  return (
    event.defaultPrevented !== true &&
    event.key.toLowerCase() === "j" &&
    event.metaKey === true &&
    event.ctrlKey !== true &&
    event.altKey !== true &&
    event.shiftKey !== true
  );
}

export function supportsAgentGUIOpenTerminalShortcut(
  provider: AgentGUIProvider
): boolean {
  return provider === "codex" || provider === "claude-code";
}

export function resolveAgentGUITerminalShortcutCwd({
  activeConversationCwd,
  selectedProjectPath,
  fallbackCwd
}: {
  activeConversationCwd?: string | null;
  selectedProjectPath?: string | null;
  fallbackCwd?: string | null;
}): string {
  return (
    activeConversationCwd?.trim() ||
    selectedProjectPath?.trim() ||
    fallbackCwd?.trim() ||
    "~"
  );
}
