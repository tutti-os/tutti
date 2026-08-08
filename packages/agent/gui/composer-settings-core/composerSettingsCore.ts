import type {
  ComposerSettingsContext,
  ComposerSettingsCorePorts,
  ComposerSettingsCoreSnapshot,
  ComposerSettingsDraft,
  ComposerSettingsState
} from "./types.ts";
import {
  applyContextChange,
  applyDraftPatch,
  applyFetchFailed,
  applyFetchResolved,
  applyFetchResolvedEmpty,
  createComposerSettingsState,
  issueFetch,
  projectComposerSettingsSnapshot,
  resolveComposerSettings
} from "./composerSettingsState.ts";

/**
 * Host-agnostic composer settings policy: owns the sparse settings draft and
 * the fenced options lifecycle, seeds display from the daemon's
 * defaults-merged effectiveSettings, and writes explicit picks back to the
 * canonical per-target defaults ledger through a port. Views bind through the
 * external-store contract (stable subscribe/getSnapshot references).
 */
export class ComposerSettingsCore {
  private readonly ports: ComposerSettingsCorePorts;
  private state: ComposerSettingsState;
  private snapshot: ComposerSettingsCoreSnapshot;
  private readonly listeners = new Set<() => void>();
  private disposed = false;
  private pendingDefaults: {
    agentTargetId: string;
    patch: ComposerSettingsDraft;
  } | null = null;
  private defaultsWriteInFlight = false;

  constructor(
    ports: ComposerSettingsCorePorts,
    context: ComposerSettingsContext
  ) {
    this.ports = ports;
    this.state = createComposerSettingsState(context);
    this.snapshot = projectComposerSettingsSnapshot(this.state);
  }

  readonly getSnapshot = (): ComposerSettingsCoreSnapshot => this.snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /**
   * Target changes reset draft and options (per-target facts) and drop any
   * unwritten defaults patch for the previous target; cwd-only changes keep
   * the draft. Either way the current catalog is re-fetched and any in-flight
   * response is fenced out.
   */
  setContext(context: ComposerSettingsContext): void {
    const previousTargetId = this.state.agentTargetId;
    const next = applyContextChange(this.state, context);
    if (next === this.state) {
      return;
    }
    this.state = next;
    if (this.state.agentTargetId !== previousTargetId) {
      this.pendingDefaults = null;
    }
    this.startFetch();
  }

  /** Merge explicit picks, refresh against them, and persist them. */
  setSettings(patch: ComposerSettingsDraft): void {
    this.state = applyDraftPatch(this.state, patch);
    this.queueRememberDefaults(patch);
    this.startFetch();
  }

  refresh(): void {
    this.startFetch();
  }

  /**
   * The exact values the composer currently displays; submissions must carry
   * them verbatim so empty fields are never re-interpreted downstream.
   */
  resolveSubmitSettings(): ComposerSettingsDraft {
    return resolveComposerSettings(this.state.draft, this.state.options);
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
    this.pendingDefaults = null;
  }

  private startFetch(): void {
    this.state = issueFetch(this.state);
    const revision = this.state.fetchRevision;
    const { agentTargetId, cwd, draft } = this.state;
    if (!agentTargetId) {
      // No target yet (e.g. before the launcher resolves one): settle
      // silently so the fence stays consistent without surfacing an error.
      this.state = applyFetchResolvedEmpty(this.state, revision);
      this.emit();
      return;
    }
    this.emit();
    void this.ports
      .fetchOptions({
        agentTargetId,
        cwd,
        settings: Object.keys(draft).length > 0 ? draft : null
      })
      .then(
        (options) => {
          if (this.disposed) {
            return;
          }
          this.state = applyFetchResolved(this.state, revision, options);
          this.emit();
        },
        (error: unknown) => {
          if (this.disposed) {
            return;
          }
          this.state = applyFetchFailed(
            this.state,
            revision,
            error instanceof Error ? error.message : String(error)
          );
          this.emit();
        }
      );
  }

  /**
   * Trailing-edge coalescing: one write in flight, later picks merge into a
   * single pending patch, and the pending patch is re-drained after the
   * in-flight write settles. Write failures are dropped — persistence must
   * never block or fail the composer.
   */
  private queueRememberDefaults(patch: ComposerSettingsDraft): void {
    if (!this.ports.rememberDefaults) {
      return;
    }
    const agentTargetId = this.state.agentTargetId;
    if (!agentTargetId) {
      return;
    }
    this.pendingDefaults =
      this.pendingDefaults?.agentTargetId === agentTargetId
        ? { agentTargetId, patch: { ...this.pendingDefaults.patch, ...patch } }
        : { agentTargetId, patch };
    void this.drainRememberDefaults();
  }

  private async drainRememberDefaults(): Promise<void> {
    if (this.defaultsWriteInFlight) {
      return;
    }
    this.defaultsWriteInFlight = true;
    try {
      while (this.pendingDefaults && !this.disposed) {
        const { agentTargetId, patch } = this.pendingDefaults;
        this.pendingDefaults = null;
        try {
          await this.ports.rememberDefaults?.(agentTargetId, patch);
        } catch (error: unknown) {
          // Non-blocking by contract; the pick still applies to this session.
          this.ports.reportDiagnostic?.(
            "composer_settings.defaults_write_failed",
            {
              agentTargetId,
              error: error instanceof Error ? error.message : String(error)
            }
          );
        }
      }
    } finally {
      this.defaultsWriteInFlight = false;
    }
  }

  private emit(): void {
    this.snapshot = projectComposerSettingsSnapshot(this.state);
    for (const listener of this.listeners) {
      listener();
    }
  }
}
