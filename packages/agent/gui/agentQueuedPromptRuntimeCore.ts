import type { AgentGUIQueuedPromptVM } from "./agent-gui/agentGuiNode/model/agentGuiNodeTypes";
import type { AgentPromptContentBlock } from "./shared/contracts/dto";

export interface AgentQueuedPromptRetryBlock {
  queuedPromptId: string;
  sessionStateUpdatedAtUnixMs: number | null;
  conversationUpdatedAtUnixMs: number | null;
}

export interface AgentQueuedPromptClaim {
  agentSessionId: string;
  claimId: string;
  ownerId: string;
  promptId: string;
  leasedUntilUnixMs: number;
  workspaceId: string;
}

export interface AgentQueuedPromptQueueSnapshot {
  agentSessionId: string;
  claim: AgentQueuedPromptClaim | null;
  failedPromptId: string | null;
  prompts: readonly AgentGUIQueuedPromptVM[];
  retryBlock: AgentQueuedPromptRetryBlock | null;
  sendNextPromptId: string | null;
  workspaceId: string;
}

export interface AgentQueuedPromptSnapshot {
  queuesByKey: Readonly<Record<string, AgentQueuedPromptQueueSnapshot>>;
  version: number;
}

export interface AgentQueuedPromptClaimResult {
  claim: AgentQueuedPromptClaim;
  prompt: AgentGUIQueuedPromptVM;
}

export interface AgentQueuedPromptRuntime {
  claimNextToDrain(input: {
    agentSessionId: string;
    leaseMs?: number;
    ownerId: string;
    workspaceId: string;
  }): AgentQueuedPromptClaimResult | null;
  cleanupSession(input: { agentSessionId: string; workspaceId: string }): void;
  completeClaim(input: {
    agentSessionId: string;
    claimId: string;
    ownerId: string;
    workspaceId: string;
  }): boolean;
  enqueue(input: {
    prompt: AgentGUIQueuedPromptVM;
    agentSessionId: string;
    workspaceId: string;
  }): void;
  getSessionSnapshot(input: {
    agentSessionId: string;
    workspaceId: string;
  }): AgentQueuedPromptQueueSnapshot;
  getSnapshot(): AgentQueuedPromptSnapshot;
  markPromptFailed(input: {
    agentSessionId: string;
    promptId: string;
    workspaceId: string;
  }): void;
  promotePrompt(input: {
    agentSessionId: string;
    promptId: string;
    workspaceId: string;
  }): void;
  releaseClaim(input: {
    agentSessionId: string;
    claimId: string;
    ownerId: string;
    workspaceId: string;
  }): boolean;
  /** @deprecated Queue drain owners should release exact claims by claim id. */
  releaseOwner(ownerId: string): void;
  removePrompt(input: {
    agentSessionId: string;
    promptId: string;
    workspaceId: string;
  }): AgentGUIQueuedPromptVM | null;
  setRetryBlock(input: {
    agentSessionId: string;
    retryBlock: AgentQueuedPromptRetryBlock | null;
    workspaceId: string;
  }): void;
  subscribe(listener: () => void): () => void;
}

const DEFAULT_CLAIM_LEASE_MS = 30_000;

export const EMPTY_AGENT_QUEUED_PROMPT_SNAPSHOT: AgentQueuedPromptSnapshot =
  Object.freeze({
    queuesByKey: Object.freeze({}),
    version: 0
  });

function logAgentQueuedPromptRuntime(
  event: string,
  details: Record<string, unknown>
): void {
  void event;
  void details;
}

export function createAgentQueuedPromptRuntime(): AgentQueuedPromptRuntime {
  let snapshot = EMPTY_AGENT_QUEUED_PROMPT_SNAPSHOT;
  const emptyQueuesByKey = new Map<string, AgentQueuedPromptQueueSnapshot>();
  const expiredClaimsByKey = new Map<string, AgentQueuedPromptClaim>();
  const listeners = new Set<() => void>();
  let claimExpiryTimer: ReturnType<typeof setTimeout> | null = null;

  const notify = (): void => {
    for (const listener of [...listeners]) {
      listener();
    }
  };

  const updateQueue = (
    workspaceId: string,
    agentSessionId: string,
    updater: (
      queue: AgentQueuedPromptQueueSnapshot
    ) => AgentQueuedPromptQueueSnapshot | null,
    options?: { releaseExpiredClaim?: boolean }
  ): void => {
    const key = queueKey(workspaceId, agentSessionId);
    const current =
      snapshot.queuesByKey[key] ??
      getEmptyQueueSnapshot(emptyQueuesByKey, { workspaceId, agentSessionId });
    const queueForUpdate =
      options?.releaseExpiredClaim === false
        ? current
        : withExpiredClaimReleased(current);
    if (queueForUpdate !== current && current.claim) {
      expiredClaimsByKey.set(key, current.claim);
    }
    const nextQueue = updater(queueForUpdate);
    if (nextQueue === current) {
      return;
    }
    const nextQueuesByKey: Record<string, AgentQueuedPromptQueueSnapshot> = {
      ...snapshot.queuesByKey
    };
    if (nextQueue === null || isEmptyQueue(nextQueue)) {
      delete nextQueuesByKey[key];
    } else {
      nextQueuesByKey[key] = freezeQueue(nextQueue);
    }
    clearExpiredClaimIfReplaced(expiredClaimsByKey, key, nextQueue);
    snapshot = Object.freeze({
      queuesByKey: Object.freeze(nextQueuesByKey),
      version: snapshot.version + 1
    });
    scheduleClaimExpiryWakeup();
    notify();
  };

  const releaseExpiredClaims = (): void => {
    claimExpiryTimer = null;
    let changed = false;
    const nextQueuesByKey: Record<string, AgentQueuedPromptQueueSnapshot> = {
      ...snapshot.queuesByKey
    };
    for (const [key, queue] of Object.entries(snapshot.queuesByKey)) {
      const nextQueue = withExpiredClaimReleased(queue);
      if (nextQueue === queue) {
        continue;
      }
      changed = true;
      if (queue.claim) {
        expiredClaimsByKey.set(key, queue.claim);
      }
      if (isEmptyQueue(nextQueue)) {
        delete nextQueuesByKey[key];
      } else {
        nextQueuesByKey[key] = nextQueue;
      }
    }
    if (changed) {
      snapshot = Object.freeze({
        queuesByKey: Object.freeze(nextQueuesByKey),
        version: snapshot.version + 1
      });
      notify();
    }
    scheduleClaimExpiryWakeup();
  };

  const scheduleClaimExpiryWakeup = (): void => {
    if (claimExpiryTimer) {
      clearTimeout(claimExpiryTimer);
      claimExpiryTimer = null;
    }
    let nextExpiryUnixMs: number | null = null;
    for (const queue of Object.values(snapshot.queuesByKey)) {
      if (!queue.claim) {
        continue;
      }
      nextExpiryUnixMs =
        nextExpiryUnixMs === null
          ? queue.claim.leasedUntilUnixMs
          : Math.min(nextExpiryUnixMs, queue.claim.leasedUntilUnixMs);
    }
    if (nextExpiryUnixMs === null) {
      return;
    }
    claimExpiryTimer = setTimeout(
      releaseExpiredClaims,
      Math.max(1, nextExpiryUnixMs - Date.now() + 1)
    );
    (claimExpiryTimer as { unref?: () => void }).unref?.();
  };

  return {
    claimNextToDrain(input) {
      const workspaceId = input.workspaceId.trim();
      const agentSessionId = input.agentSessionId.trim();
      const ownerId = input.ownerId.trim();
      if (!workspaceId || !agentSessionId || !ownerId) {
        return null;
      }
      const current = withExpiredClaimReleased(
        snapshot.queuesByKey[queueKey(workspaceId, agentSessionId)] ??
          getEmptyQueueSnapshot(emptyQueuesByKey, {
            workspaceId,
            agentSessionId
          })
      );
      if (current.claim || current.prompts.length === 0) {
        return null;
      }
      const prompt = current.prompts[0]!;
      const claim: AgentQueuedPromptClaim = Object.freeze({
        workspaceId,
        agentSessionId,
        ownerId,
        promptId: prompt.id,
        claimId: `claim-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        leasedUntilUnixMs:
          Date.now() + Math.max(1, input.leaseMs ?? DEFAULT_CLAIM_LEASE_MS)
      });
      updateQueue(workspaceId, agentSessionId, (queue) => ({
        ...queue,
        claim
      }));
      expiredClaimsByKey.delete(queueKey(workspaceId, agentSessionId));
      logAgentQueuedPromptRuntime("claim", {
        workspaceId,
        agentSessionId,
        ownerId,
        promptId: prompt.id,
        claimId: claim.claimId,
        queueLength: current.prompts.length
      });
      return { claim, prompt };
    },
    cleanupSession(input) {
      const workspaceId = input.workspaceId.trim();
      const agentSessionId = input.agentSessionId.trim();
      if (!workspaceId || !agentSessionId) {
        return;
      }
      updateQueue(workspaceId, agentSessionId, () => null);
      expiredClaimsByKey.delete(queueKey(workspaceId, agentSessionId));
    },
    completeClaim(input) {
      let completed = false;
      const key = queueKey(input.workspaceId, input.agentSessionId);
      updateQueue(
        input.workspaceId,
        input.agentSessionId,
        (queue) => {
          const matchingClaim = claimMatches(queue.claim, input)
            ? queue.claim
            : queue.claim === null &&
                claimMatches(expiredClaimsByKey.get(key) ?? null, input)
              ? expiredClaimsByKey.get(key)!
              : null;
          if (!matchingClaim) {
            return queue;
          }
          completed = true;
          const promptId = matchingClaim.promptId;
          expiredClaimsByKey.delete(key);
          logAgentQueuedPromptRuntime("complete-claim", {
            workspaceId: input.workspaceId,
            agentSessionId: input.agentSessionId,
            ownerId: input.ownerId,
            promptId,
            claimId: input.claimId
          });
          return {
            ...queue,
            claim: null,
            failedPromptId:
              queue.failedPromptId === promptId ? null : queue.failedPromptId,
            prompts: Object.freeze(
              queue.prompts.filter((prompt) => prompt.id !== promptId)
            ),
            retryBlock:
              queue.retryBlock?.queuedPromptId === promptId
                ? null
                : queue.retryBlock,
            sendNextPromptId:
              queue.sendNextPromptId === promptId
                ? null
                : queue.sendNextPromptId
          };
        },
        { releaseExpiredClaim: false }
      );
      return completed;
    },
    enqueue(input) {
      updateQueue(input.workspaceId, input.agentSessionId, (queue) => ({
        ...queue,
        prompts: Object.freeze([...queue.prompts, freezePrompt(input.prompt)])
      }));
      logAgentQueuedPromptRuntime("enqueue", {
        workspaceId: input.workspaceId,
        agentSessionId: input.agentSessionId,
        promptId: input.prompt.id
      });
    },
    getSessionSnapshot(input) {
      const workspaceId = input.workspaceId.trim();
      const agentSessionId = input.agentSessionId.trim();
      const key = queueKey(workspaceId, agentSessionId);
      const current =
        snapshot.queuesByKey[key] ??
        getEmptyQueueSnapshot(emptyQueuesByKey, {
          workspaceId,
          agentSessionId
        });
      const next = withExpiredClaimReleased(current);
      if (next !== current) {
        updateQueue(workspaceId, agentSessionId, () => next);
      }
      return snapshot.queuesByKey[key] ?? next;
    },
    getSnapshot() {
      return snapshot;
    },
    markPromptFailed(input) {
      updateQueue(input.workspaceId, input.agentSessionId, (queue) => ({
        ...queue,
        failedPromptId: input.promptId.trim() || queue.failedPromptId
      }));
      logAgentQueuedPromptRuntime("mark-failed", {
        workspaceId: input.workspaceId,
        agentSessionId: input.agentSessionId,
        promptId: input.promptId
      });
    },
    promotePrompt(input) {
      const promptId = input.promptId.trim();
      if (!promptId) {
        return;
      }
      updateQueue(input.workspaceId, input.agentSessionId, (queue) => {
        const index = queue.prompts.findIndex(
          (prompt) => prompt.id === promptId
        );
        if (index < 0) {
          return queue;
        }
        if (queue.claim?.promptId === promptId) {
          return queue;
        }
        const prompts = [...queue.prompts];
        if (index > 0) {
          const [selected] = prompts.splice(index, 1);
          prompts.unshift(selected!);
        }
        return {
          ...queue,
          failedPromptId:
            queue.failedPromptId === promptId ? null : queue.failedPromptId,
          prompts: Object.freeze(prompts),
          retryBlock:
            queue.retryBlock?.queuedPromptId === promptId
              ? null
              : queue.retryBlock,
          sendNextPromptId: promptId
        };
      });
    },
    releaseClaim(input) {
      let released = false;
      updateQueue(input.workspaceId, input.agentSessionId, (queue) => {
        if (!claimMatches(queue.claim, input)) {
          return queue;
        }
        released = true;
        logAgentQueuedPromptRuntime("release-claim", {
          workspaceId: input.workspaceId,
          agentSessionId: input.agentSessionId,
          ownerId: input.ownerId,
          claimId: input.claimId,
          promptId: queue.claim.promptId
        });
        return { ...queue, claim: null };
      });
      return released;
    },
    releaseOwner(ownerId) {
      const normalizedOwnerId = ownerId.trim();
      if (!normalizedOwnerId) {
        return;
      }
      for (const queue of Object.values(snapshot.queuesByKey)) {
        if (queue.claim?.ownerId === normalizedOwnerId) {
          updateQueue(queue.workspaceId, queue.agentSessionId, (current) => ({
            ...current,
            claim:
              current.claim?.ownerId === normalizedOwnerId
                ? null
                : current.claim
          }));
        }
      }
    },
    removePrompt(input) {
      const promptId = input.promptId.trim();
      if (!promptId) {
        return null;
      }
      let removed: AgentGUIQueuedPromptVM | null = null;
      updateQueue(input.workspaceId, input.agentSessionId, (queue) => {
        removed =
          queue.prompts.find((prompt) => prompt.id === promptId) ?? null;
        if (!removed) {
          return queue;
        }
        if (queue.claim?.promptId === promptId) {
          removed = null;
          return queue;
        }
        const key = queueKey(input.workspaceId, input.agentSessionId);
        if (expiredClaimsByKey.get(key)?.promptId === promptId) {
          expiredClaimsByKey.delete(key);
        }
        return {
          ...queue,
          claim: queue.claim?.promptId === promptId ? null : queue.claim,
          failedPromptId:
            queue.failedPromptId === promptId ? null : queue.failedPromptId,
          prompts: Object.freeze(
            queue.prompts.filter((prompt) => prompt.id !== promptId)
          ),
          retryBlock:
            queue.retryBlock?.queuedPromptId === promptId
              ? null
              : queue.retryBlock,
          sendNextPromptId:
            queue.sendNextPromptId === promptId ? null : queue.sendNextPromptId
        };
      });
      return removed;
    },
    setRetryBlock(input) {
      updateQueue(input.workspaceId, input.agentSessionId, (queue) => ({
        ...queue,
        retryBlock: input.retryBlock
          ? Object.freeze({ ...input.retryBlock })
          : null
      }));
      logAgentQueuedPromptRuntime("set-retry-block", {
        workspaceId: input.workspaceId,
        agentSessionId: input.agentSessionId,
        retryBlock: input.retryBlock
      });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }
  };
}

function queueKey(workspaceId: string, agentSessionId: string): string {
  return `${workspaceId.trim()}\0${agentSessionId.trim()}`;
}

function emptyQueueSnapshot(input: {
  workspaceId: string;
  agentSessionId: string;
}): AgentQueuedPromptQueueSnapshot {
  return freezeQueue({
    workspaceId: input.workspaceId,
    agentSessionId: input.agentSessionId,
    claim: null,
    failedPromptId: null,
    prompts: Object.freeze([]),
    retryBlock: null,
    sendNextPromptId: null
  });
}

function getEmptyQueueSnapshot(
  cache: Map<string, AgentQueuedPromptQueueSnapshot>,
  input: {
    workspaceId: string;
    agentSessionId: string;
  }
): AgentQueuedPromptQueueSnapshot {
  const key = queueKey(input.workspaceId, input.agentSessionId);
  const existing = cache.get(key);
  if (existing) {
    return existing;
  }
  const next = emptyQueueSnapshot(input);
  cache.set(key, next);
  return next;
}

function freezePrompt(prompt: AgentGUIQueuedPromptVM): AgentGUIQueuedPromptVM {
  return Object.freeze({
    ...prompt,
    content: Object.freeze([
      ...prompt.content
    ]) as unknown as AgentPromptContentBlock[]
  });
}

function freezeQueue(
  queue: AgentQueuedPromptQueueSnapshot
): AgentQueuedPromptQueueSnapshot {
  return Object.freeze({
    ...queue,
    claim: queue.claim ? Object.freeze({ ...queue.claim }) : null,
    prompts: Object.freeze(queue.prompts.map(freezePrompt)),
    retryBlock: queue.retryBlock ? Object.freeze({ ...queue.retryBlock }) : null
  });
}

function withExpiredClaimReleased(
  queue: AgentQueuedPromptQueueSnapshot
): AgentQueuedPromptQueueSnapshot {
  if (!queue.claim || queue.claim.leasedUntilUnixMs > Date.now()) {
    return queue;
  }
  return freezeQueue({ ...queue, claim: null });
}

function isEmptyQueue(queue: AgentQueuedPromptQueueSnapshot): boolean {
  return (
    queue.prompts.length === 0 &&
    queue.claim === null &&
    queue.failedPromptId === null &&
    queue.retryBlock === null &&
    queue.sendNextPromptId === null
  );
}

function claimMatches(
  claim: AgentQueuedPromptClaim | null,
  input: {
    agentSessionId: string;
    claimId: string;
    ownerId: string;
    workspaceId: string;
  }
): claim is AgentQueuedPromptClaim {
  return (
    claim !== null &&
    claim.workspaceId === input.workspaceId.trim() &&
    claim.agentSessionId === input.agentSessionId.trim() &&
    claim.ownerId === input.ownerId.trim() &&
    claim.claimId === input.claimId.trim()
  );
}

function clearExpiredClaimIfReplaced(
  expiredClaimsByKey: Map<string, AgentQueuedPromptClaim>,
  key: string,
  queue: AgentQueuedPromptQueueSnapshot | null
): void {
  const expiredClaim = expiredClaimsByKey.get(key);
  if (
    expiredClaim &&
    (queue === null ||
      queue.claim !== null ||
      !queue.prompts.some((prompt) => prompt.id === expiredClaim.promptId))
  ) {
    expiredClaimsByKey.delete(key);
  }
}
