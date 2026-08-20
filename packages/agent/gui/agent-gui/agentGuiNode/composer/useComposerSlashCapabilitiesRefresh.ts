import { useEffect, useRef } from "react";
import type { AgentComposerProps } from "./AgentComposer.types";

export function useComposerSlashCapabilitiesRefresh(input: {
  agentSessionId: string | null;
  isPaletteOpen: boolean;
  onRetryComposerOptions: AgentComposerProps["onRetryComposerOptions"];
  slashQuery: string | null;
}): void {
  const refreshedSessionRef = useRef<string | null>(null);

  useEffect(() => {
    const refreshKey =
      input.isPaletteOpen && input.slashQuery !== null
        ? input.agentSessionId
        : null;
    if (refreshKey === null) {
      refreshedSessionRef.current = null;
      return;
    }
    if (refreshedSessionRef.current === refreshKey) {
      return;
    }
    refreshedSessionRef.current = refreshKey;
    input.onRetryComposerOptions?.({
      force: true,
      section: "capabilities"
    });
  }, [
    input.agentSessionId,
    input.isPaletteOpen,
    input.onRetryComposerOptions,
    input.slashQuery
  ]);
}
