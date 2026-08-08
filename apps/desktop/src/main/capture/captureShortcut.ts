export const desktopCaptureShortcutKeys = [
  "CommandOrControl",
  "Shift",
  "S"
] as const;

export const desktopCaptureAccelerator = desktopCaptureShortcutKeys.join("+");

const bindingModifiers = new Set(["Meta", "Ctrl", "Alt", "Shift"]);

const acceleratorKeyByBindingKey: Record<string, string> = {
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowUp: "Up"
};

/**
 * Maps a persisted capture shortcut binding (e.g. "Meta+Shift+S") onto an
 * Electron accelerator. Malformed bindings and bindings without a
 * Meta/Ctrl/Alt modifier resolve to the built-in default, so a bad
 * preference can never disable capture or shadow plain typing system-wide.
 */
export function resolveCaptureAccelerator(
  binding: string | null | undefined
): string {
  const normalized = binding?.trim() ?? "";
  if (!normalized) {
    return desktopCaptureAccelerator;
  }
  const parts = normalized.split("+").filter(Boolean);
  if (parts.length < 2) {
    return desktopCaptureAccelerator;
  }
  const key = parts[parts.length - 1] as string;
  const modifiers = parts.slice(0, -1);
  if (
    bindingModifiers.has(key) ||
    !modifiers.every((modifier) => bindingModifiers.has(modifier)) ||
    !modifiers.some((modifier) => modifier !== "Shift")
  ) {
    return desktopCaptureAccelerator;
  }
  return [...modifiers, acceleratorKeyByBindingKey[key] ?? key].join("+");
}
