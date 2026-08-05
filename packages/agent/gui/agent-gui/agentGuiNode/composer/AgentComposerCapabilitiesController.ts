import type {
  AgentHostComposerCapabilitiesApi,
  AgentHostComposerCapabilitiesSnapshot,
  AgentHostComposerCapabilitySkillEntry
} from "../../../host/agentHostApi";
import {
  agentGuiScheduler,
  type AgentGuiScheduledTask,
  type AgentGuiScheduler
} from "../agentGuiScheduler";

const EMPTY_SNAPSHOT: AgentHostComposerCapabilitiesSnapshot = {
  capabilities: [],
  hiddenSlashSkillEntryIds: [],
  partial: true
};

const PARTIAL_SNAPSHOT_RETRY_DELAYS_MS = [
  100, 200, 400, 800, 1_600, 3_200, 2_000
];

export interface AgentComposerCapabilitiesScope {
  agentTargetId: string;
  authoritativeSkills: readonly AgentHostComposerCapabilitySkillEntry[];
  cwd?: string;
  key: string;
  provider: string;
  supported: boolean;
}

export interface AgentComposerCapabilitiesControllerSnapshot {
  scopeKey: string | null;
  snapshot: AgentHostComposerCapabilitiesSnapshot;
}

export interface AgentComposerCapabilitiesController {
  getSnapshot(): AgentComposerCapabilitiesControllerSnapshot;
  subscribe(listener: () => void): () => void;
  sync(input: { active: boolean; scope: AgentComposerCapabilitiesScope }): void;
}

export interface CreateAgentComposerCapabilitiesControllerInput {
  source: AgentHostComposerCapabilitiesApi | undefined;
  scheduler?: AgentGuiScheduler;
}

const INITIAL_SNAPSHOT: AgentComposerCapabilitiesControllerSnapshot = {
  scopeKey: null,
  snapshot: EMPTY_SNAPSHOT
};

/**
 * Owns bounded Composer Plugin inventory reads. It is deliberately separate
 * from React: the host remains the inventory authority, while AgentGUI keeps
 * only the current scope's transient projection and stale-response fence.
 */
export function createAgentComposerCapabilitiesController(
  input: CreateAgentComposerCapabilitiesControllerInput
): AgentComposerCapabilitiesController {
  const scheduler = input.scheduler ?? agentGuiScheduler;
  const listeners = new Set<() => void>();
  let active = false;
  let currentScope: AgentComposerCapabilitiesScope | null = null;
  let requestSequence = 0;
  let retryTask: AgentGuiScheduledTask | null = null;
  let snapshot = INITIAL_SNAPSHOT;

  const publish = (next: AgentComposerCapabilitiesControllerSnapshot): void => {
    if (
      snapshot.scopeKey === next.scopeKey &&
      snapshot.snapshot === next.snapshot
    ) {
      return;
    }
    snapshot = next;
    for (const listener of listeners) {
      listener();
    }
  };

  const cancelRetry = (): void => {
    retryTask?.cancel();
    retryTask = null;
  };

  const clear = (): void => {
    requestSequence += 1;
    cancelRetry();
    currentScope = null;
    publish(INITIAL_SNAPSHOT);
  };

  const request = (
    scope: AgentComposerCapabilitiesScope,
    retryPartial: boolean
  ): void => {
    const source = input.source;
    if (!source || !scope.supported) {
      clear();
      return;
    }
    cancelRetry();
    const requestId = ++requestSequence;
    let retryIndex = 0;
    const isCurrent = (): boolean =>
      currentScope?.key === scope.key && requestSequence === requestId;
    const read = (): void => {
      void source
        .list({
          agentTargetId: scope.agentTargetId,
          authoritativeSkills: scope.authoritativeSkills,
          cwd: scope.cwd,
          provider: scope.provider
        })
        .then((next) => {
          if (!isCurrent()) {
            return;
          }
          publish({ scopeKey: scope.key, snapshot: next });
          if (!retryPartial || !next.partial) {
            return;
          }
          const delay = PARTIAL_SNAPSHOT_RETRY_DELAYS_MS[retryIndex];
          retryIndex += 1;
          if (delay !== undefined) {
            retryTask = scheduler.schedule(delay, read);
          }
        })
        .catch(() => {
          if (!isCurrent()) {
            return;
          }
          publish({ scopeKey: scope.key, snapshot: EMPTY_SNAPSHOT });
          if (!retryPartial) {
            return;
          }
          const delay = PARTIAL_SNAPSHOT_RETRY_DELAYS_MS[retryIndex];
          retryIndex += 1;
          if (delay !== undefined) {
            retryTask = scheduler.schedule(delay, read);
          }
        });
    };
    // Prime is intentionally fire-and-forget: list is always a snapshot-only
    // read and never waits for discovery on the renderer side.
    void source
      .prime({
        agentTargetId: scope.agentTargetId,
        cwd: scope.cwd,
        provider: scope.provider
      })
      .catch(() => {});
    read();
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          requestSequence += 1;
          cancelRetry();
          currentScope = null;
          snapshot = INITIAL_SNAPSHOT;
        }
      };
    },
    sync: ({ active: nextActive, scope }) => {
      const scopeChanged = currentScope?.key !== scope.key;
      const becameActive = nextActive && !active;
      active = nextActive;
      if (!scope.supported || !input.source) {
        clear();
        return;
      }
      if (scopeChanged) {
        currentScope = scope;
        publish({ scopeKey: scope.key, snapshot: EMPTY_SNAPSHOT });
        request(scope, nextActive);
        return;
      }
      if (becameActive) {
        request(scope, true);
      }
    }
  };
}

export function selectAgentComposerCapabilitiesSnapshot(
  snapshot: AgentComposerCapabilitiesControllerSnapshot,
  scopeKey: string,
  supported: boolean
): AgentHostComposerCapabilitiesSnapshot {
  return supported && snapshot.scopeKey === scopeKey
    ? snapshot.snapshot
    : EMPTY_SNAPSHOT;
}
