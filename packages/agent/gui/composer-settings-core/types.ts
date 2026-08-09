import type {
  AgentActivityComposerOptions,
  AgentActivitySessionSettings
} from "@tutti-os/agent-activity-core";

/**
 * Sparse pre-session settings a launcher composer can draft. Structurally
 * identical to AgentGUIQuickComposerSettings; declared here so the core stays
 * free of React-adjacent imports.
 */
export type ComposerSettingsDraft = Pick<
  AgentActivitySessionSettings,
  | "browserUse"
  | "model"
  | "permissionModeId"
  | "planMode"
  | "reasoningEffort"
  | "speed"
>;

export interface ComposerSettingsContext {
  agentTargetId: string;
  cwd: string | null;
}

/**
 * Host ports. fetchOptions must resolve against the exact target/cwd/settings
 * signature; rememberDefaults persists explicit user picks into the canonical
 * per-target composer-defaults ledger (write failures are non-blocking).
 */
export interface ComposerSettingsCorePorts {
  fetchOptions(input: {
    agentTargetId: string;
    cwd: string | null;
    settings: ComposerSettingsDraft | null;
  }): Promise<AgentActivityComposerOptions>;
  rememberDefaults?(
    agentTargetId: string,
    patch: ComposerSettingsDraft
  ): Promise<void> | void;
  /** Non-blocking failure telemetry (e.g. a defaults write that was dropped). */
  reportDiagnostic?(event: string, details: Record<string, unknown>): void;
}

/**
 * Options lifecycle is a fenced state record rather than a phase enum:
 * `refreshing` derives from revision counters and `options` always holds the
 * last good catalog, so a failed refresh can never blank the menu.
 */
export interface ComposerSettingsState {
  agentTargetId: string;
  cwd: string | null;
  draft: ComposerSettingsDraft;
  /** Latest issued fetch revision; bumped by context and settings changes. */
  fetchRevision: number;
  /** Latest revision that settled (applied or failed). */
  settledRevision: number;
  /** Last good options for the current target; null until the first success. */
  options: AgentActivityComposerOptions | null;
  /** Error message from the latest settled fetch, null after a success. */
  errorMessage: string | null;
}

export interface ComposerSettingsCoreSnapshot {
  agentTargetId: string;
  cwd: string | null;
  /** Explicit user picks only. */
  draft: ComposerSettingsDraft;
  /** Last good options; never cleared by a failed refresh. */
  options: AgentActivityComposerOptions | null;
  /** A fetch is in flight. */
  refreshing: boolean;
  /** No options have ever loaded for this target. */
  initialLoading: boolean;
  /** The latest settled fetch failed; `options` is the previous good copy. */
  degraded: boolean;
  errorMessage: string | null;
  /**
   * draft ⊕ options.effectiveSettings — the exact values the composer
   * displays. Submissions must carry these verbatim so the daemon never
   * re-interprets empty fields ("display what you send").
   */
  resolvedSettings: ComposerSettingsDraft;
}
