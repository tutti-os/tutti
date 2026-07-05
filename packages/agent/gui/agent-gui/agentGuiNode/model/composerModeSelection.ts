/**
 * Maps a permission-mode dropdown selection onto a settings patch.
 *
 * Plan mode is no longer a dropdown option — it is an independent toggle
 * surfaced via Shift+Tab and the plan badge. For providers where plan mode and
 * permission mode are mutually exclusive (claude-code: plan overrides the
 * permission mode in the daemon), picking a permission mode also clears plan
 * mode. For providers where plan rides alongside the permission mode (codex:
 * plan is an independent collaboration mode), plan is left untouched.
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
 * Claude Code's Agent SDK genuinely applies a permission-mode change mid-turn
 * (`query.setPermissionMode` is documented as safe while the query is
 * streaming), and Codex has no notion of "mid-turn" for it at all -- the
 * daemon re-derives approvalPolicy/sandboxPolicy fresh from the session's
 * permissionModeId on every `turn/start` regardless of when the user picked
 * it, so leaving the control open mid-turn only lets the user queue their
 * choice sooner. Other ACP-backed providers (Nexight/Gemini/Hermes/OpenClaw)
 * apply the change via a JSON-RPC call over the same connection a turn
 * streams on, which hasn't been verified safe to interleave mid-turn, so they
 * keep the broader turn-in-flight gate that blocks all composer settings
 * while a turn is sending or the stop button is showing.
 */
export function resolvePermissionModeControlsDisabled(options: {
  provider: string;
  isSendingTurn: boolean;
  isSubmittingPrompt: boolean;
  showStopButton: boolean;
}): boolean {
  const liveDuringTurn =
    options.provider === "claude-code" || options.provider === "codex";
  if (liveDuringTurn) {
    return options.isSubmittingPrompt;
  }
  return (
    options.isSendingTurn ||
    options.isSubmittingPrompt ||
    options.showStopButton
  );
}
