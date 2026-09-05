import type { AgentComposerProps } from "./AgentComposer.types";

export function refreshComposerSlashCapabilities(input: {
  capabilitiesScopeKey: string;
  isPaletteOpen: boolean;
  onRetryComposerOptions: AgentComposerProps["onRetryComposerOptions"];
  refreshedSessionRef: { current: string | null };
  skillQuery: string | null;
  slashQuery: string | null;
}): void {
  const refreshKey =
    input.isPaletteOpen &&
    (input.slashQuery !== null || input.skillQuery !== null)
      ? input.capabilitiesScopeKey
      : null;
  if (refreshKey === null) {
    input.refreshedSessionRef.current = null;
    return;
  }
  if (input.refreshedSessionRef.current === refreshKey) {
    return;
  }
  input.refreshedSessionRef.current = refreshKey;
  input.onRetryComposerOptions?.({
    force: true,
    section: "capabilities"
  });
}
