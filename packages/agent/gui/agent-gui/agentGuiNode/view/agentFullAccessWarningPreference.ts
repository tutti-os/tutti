export const CODEX_FULL_ACCESS_WARNING_ACKNOWLEDGEMENT_STORAGE_KEY =
  "tutti.agentGui.codexFullAccessWarningAcknowledged.v1";

export function isCodexFullAccessWarningAcknowledged(): boolean {
  return (
    globalThis.localStorage?.getItem(
      CODEX_FULL_ACCESS_WARNING_ACKNOWLEDGEMENT_STORAGE_KEY
    ) === "1"
  );
}

export function acknowledgeCodexFullAccessWarning(): void {
  globalThis.localStorage?.setItem(
    CODEX_FULL_ACCESS_WARNING_ACKNOWLEDGEMENT_STORAGE_KEY,
    "1"
  );
}
