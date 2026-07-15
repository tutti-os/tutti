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
 * The runtime descriptor decides whether a permission change is safe while a
 * turn is active. Missing capability data keeps the conservative gate.
 */
export function resolvePermissionModeControlsDisabled(options: {
  changeDuringTurnSupported?: boolean;
  isSendingTurn: boolean;
  isSubmittingPrompt: boolean;
  showStopButton: boolean;
}): boolean {
  if (options.changeDuringTurnSupported) {
    return options.isSubmittingPrompt;
  }
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
