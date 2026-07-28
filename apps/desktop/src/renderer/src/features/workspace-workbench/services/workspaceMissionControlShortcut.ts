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
