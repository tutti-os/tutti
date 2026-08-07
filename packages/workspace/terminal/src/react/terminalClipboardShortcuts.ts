export type TerminalClipboardShortcutAction = "copy" | "paste";

export type TerminalClipboardPlatform = "mac" | "other";

export interface TerminalClipboardShortcutEvent {
  altKey: boolean;
  ctrlKey: boolean;
  key: string;
  metaKey: boolean;
  repeat?: boolean;
  shiftKey: boolean;
  type: string;
}

/**
 * Resolves the platform shortcuts that xterm does not consistently handle in
 * an embedded Windows/Electron terminal. Ctrl/C copies a selection while
 * Ctrl/C without a selection remains the PTY interrupt sequence.
 */
export function resolveTerminalClipboardShortcut(
  event: TerminalClipboardShortcutEvent,
  input: {
    hasSelection: boolean;
    platform: TerminalClipboardPlatform;
  }
): TerminalClipboardShortcutAction | null {
  if (event.type !== "keydown" || event.altKey || event.repeat) {
    return null;
  }

  const key = event.key.toLowerCase();
  if (input.platform === "mac" && !event.metaKey) {
    return null;
  }
  if (
    input.platform !== "mac" &&
    !event.ctrlKey &&
    !(event.shiftKey && key === "insert")
  ) {
    return null;
  }
  if (input.platform !== "mac" && event.shiftKey && key === "insert") {
    return "paste";
  }
  if (input.platform !== "mac" && event.ctrlKey && key === "insert") {
    return input.hasSelection ? "copy" : null;
  }
  if (key === "c" && input.hasSelection) {
    return "copy";
  }
  if (key === "v") {
    return "paste";
  }
  return null;
}

export function resolveTerminalClipboardPlatform(): TerminalClipboardPlatform {
  if (typeof navigator !== "undefined" && /Mac/i.test(navigator.platform)) {
    return "mac";
  }
  return "other";
}
