/**
 * Normalizes a value emitted by the permission select.
 *
 * Radix can emit an empty value while a controlled select closes and restores
 * focus. That is transient UI state, not a user request to clear permissions.
 */
export function normalizePermissionModeSelection(
  permissionModeId: string
): string | null {
  const normalized = permissionModeId.trim();
  return normalized || null;
}

/**
 * Maps a permission-mode dropdown selection onto a settings patch.
 *
 * Plan mode is no longer a dropdown option — it is an independent toggle
 * surfaced via Shift+Tab and the plan badge. The caller-provided option
 * decides whether selecting a permission mode also clears plan mode.
 */
export function permissionModeSelectionPatch(
  permissionModeId: string,
  options: { clearsPlanMode: boolean }
): { permissionModeId: string; planMode?: boolean } {
  return options.clearsPlanMode
    ? { permissionModeId, planMode: false }
    : { permissionModeId };
}

/**
 * Decides whether the composer's permission-mode control should be disabled
 * while a turn is in flight.
 *
 * AgentGUI keeps the permission contract stable for the whole active turn,
 * even when the provider runtime can technically apply changes live.
 */
export function resolvePermissionModeControlsDisabled(options: {
  isSendingTurn: boolean;
  isSubmittingPrompt: boolean;
  showStopButton: boolean;
}): boolean {
  return (
    options.isSendingTurn ||
    options.isSubmittingPrompt ||
    options.showStopButton
  );
}

/**
 * A settings timeout means delivery is uncertain, so the engine blocks a new
 * command until the caller explicitly identifies a user retry. A fresh menu
 * selection is that explicit retry; ordinary idle/in-flight/failed updates are
 * not.
 */
export function shouldRetrySessionSettingsUpdate(
  status: string | null | undefined
): boolean {
  return status === "unknown";
}
