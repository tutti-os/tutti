export function isWorkspaceMissionControlActivateShortcut(
  event: Pick<KeyboardEvent, "altKey" | "ctrlKey" | "key" | "metaKey">
): boolean {
  if (event.altKey) {
    return false;
  }

  if (!(event.metaKey || event.ctrlKey)) {
    return false;
  }

  return event.key === "1";
}

export function isWorkspaceMissionControlLayoutShortcut(
  event: Pick<KeyboardEvent, "altKey" | "ctrlKey" | "key" | "metaKey">
): boolean {
  if (event.altKey) {
    return false;
  }

  if (!(event.metaKey || event.ctrlKey)) {
    return false;
  }

  return event.key === "2";
}

export function isWorkspaceSettingsShortcut(
  event: Pick<KeyboardEvent, "altKey" | "ctrlKey" | "key" | "metaKey">
): boolean {
  if (event.altKey) {
    return false;
  }

  if (!(event.metaKey || event.ctrlKey)) {
    return false;
  }

  return event.key === ",";
}

export function isWorkspaceAgentNewConversationShortcut(
  event: Pick<KeyboardEvent, "altKey" | "ctrlKey" | "key" | "metaKey">
): boolean {
  if (event.altKey) {
    return false;
  }

  if (!(event.metaKey || event.ctrlKey)) {
    return false;
  }

  return event.key.toLowerCase() === "n";
}
