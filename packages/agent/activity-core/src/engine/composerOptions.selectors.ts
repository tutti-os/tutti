import type {
  AgentActivityComposerOptions,
  AgentActivityComposerOptionsLoadStatus
} from "../types.ts";
import type { AgentSessionEngineState } from "./types.ts";

export function selectComposerOptions(
  state: AgentSessionEngineState,
  targetKey: string | null | undefined
): AgentActivityComposerOptions | null {
  const key = targetKey?.trim() ?? "";
  if (!key) return null;
  return state.composerOptions.optionsByTargetKey[key] ?? null;
}

export function selectComposerOptionsLoadStatus(
  state: AgentSessionEngineState,
  targetKey: string | null | undefined
): AgentActivityComposerOptionsLoadStatus | undefined {
  const key = targetKey?.trim() ?? "";
  if (!key) return undefined;
  return state.composerOptions.entriesByTargetKey[key]?.status;
}
