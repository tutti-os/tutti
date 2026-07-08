import { formatDesktopShortcutBinding } from "../../../../../shared/preferences/index.ts";
import type { DesktopWorkbenchShortcuts } from "../../../../../shared/preferences/index.ts";

export type WorkbenchShortcutAction =
  | "new-agent-conversation"
  | "new-same-type-window";

export function resolveWorkbenchShortcutAction(
  event: KeyboardEvent,
  shortcuts: DesktopWorkbenchShortcuts
): WorkbenchShortcutAction | null {
  const binding = formatDesktopShortcutBinding({
    key: event.key,
    metaKey: event.metaKey,
    ctrlKey: event.ctrlKey,
    altKey: event.altKey,
    shiftKey: event.shiftKey
  });
  if (!binding) {
    return null;
  }
  if (shortcuts.newAgentConversation === binding) {
    return "new-agent-conversation";
  }
  if (shortcuts.newSameTypeWindow === binding) {
    return "new-same-type-window";
  }
  return null;
}
