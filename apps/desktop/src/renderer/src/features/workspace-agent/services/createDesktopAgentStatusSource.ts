import type {
  AgentGUIAgent,
  AgentGUIProps,
  AgentHostInputApi,
  AgentStatusSource,
  AgentStatusValue
} from "@tutti-os/agent-gui";

interface DesktopAgentStatusSourceInput {
  agentActivityRuntime: AgentGUIProps["agentActivityRuntime"];
  agents: readonly AgentGUIAgent[] | (() => readonly AgentGUIAgent[]);
  workspaceAgentProbes: AgentHostInputApi["workspaceAgentProbes"];
  workspaceId: string;
}

interface DesktopWorkspaceAgentStatusSourceOptions {
  forcedRefreshDebounceMs?: number;
  now?: () => number;
  retainedSnapshotMs?: number;
}

type WorkspaceAgentProbeSnapshot = Awaited<
  ReturnType<NonNullable<AgentHostInputApi["workspaceAgentProbes"]>["list"]>
>;

const desktopStatusRetainedSnapshotMs = 60 * 60_000;
const desktopStatusForcedRefreshDebounceMs = 5_000;

/**
 * Adapts Desktop's canonical activity/probe ports to AgentGUI's bounded status
 * source. Target and Session identity are resolved here at the host boundary;
 * AgentGUI never infers a provider from an opaque target id.
 */
export function createDesktopAgentStatusSource(
  input: DesktopAgentStatusSourceInput
): AgentStatusSource {
  return {
    open(query, observer) {
      let closed = false;
      const request = resolveDesktopAgentStatusRequest(input, query);
      if ("errorCode" in request) {
        observer.onError({ code: request.errorCode });
        return () => {
          closed = true;
        };
      }

      void request.workspaceAgentProbes
        .list({
          includeUsage: true,
          providers: [request.agent.provider],
          refresh: true,
          workspaceId: request.workspaceId
        })
        .then((snapshot) => {
          if (closed) return;
          observer.onFrame({
            kind: "refreshed",
            value: statusValueFromDesktopProbeSnapshot(request, snapshot)
          });
          observer.onComplete();
        })
        .catch(() => {
          if (!closed) {
            observer.onError({ code: "unavailable" });
          }
        });

      return () => {
        closed = true;
      };
    }
  };
}

/**
 * Shares Provider probe work across AgentGUI surfaces without sharing their
 * query, loading, or close state.
 */
export function createDesktopWorkspaceAgentStatusSource(
  input: DesktopAgentStatusSourceInput,
  options: DesktopWorkspaceAgentStatusSourceOptions = {}
): AgentStatusSource {
  const now = options.now ?? Date.now;
  const retainedSnapshotMs =
    options.retainedSnapshotMs ?? desktopStatusRetainedSnapshotMs;
  const forcedRefreshDebounceMs =
    options.forcedRefreshDebounceMs ?? desktopStatusForcedRefreshDebounceMs;
  const retainedByProvider = new Map<
    string,
    { receivedAtUnixMs: number; snapshot: WorkspaceAgentProbeSnapshot }
  >();
  const refreshByProvider = new Map<
    string,
    Promise<WorkspaceAgentProbeSnapshot>
  >();
  const lastRefreshAtByProvider = new Map<string, number>();

  return {
    open(query, observer) {
      let closed = false;
      const request = resolveDesktopAgentStatusRequest(input, query);
      if ("errorCode" in request) {
        observer.onError({ code: request.errorCode });
        return () => {
          closed = true;
        };
      }

      const requestedAt = now();
      pruneDesktopAgentStatusCache({
        lastRefreshAtByProvider,
        retainedByProvider,
        retainedSnapshotMs,
        requestedAt
      });
      const provider = request.agent.provider;
      const retained = retainedByProvider.get(provider);
      if (retained) {
        observer.onFrame({
          kind: "snapshot",
          value: statusValueFromDesktopProbeSnapshot(request, retained.snapshot)
        });
      }

      let refresh = refreshByProvider.get(provider);
      const lastRefreshAt = lastRefreshAtByProvider.get(provider);
      if (
        !refresh &&
        lastRefreshAt !== undefined &&
        requestedAt - lastRefreshAt < forcedRefreshDebounceMs
      ) {
        if (retained) {
          observer.onComplete();
        } else {
          observer.onError({ code: "unavailable" });
        }
        return () => {
          closed = true;
        };
      }

      if (!refresh) {
        lastRefreshAtByProvider.set(provider, requestedAt);
        refresh = Promise.resolve().then(() =>
          request.workspaceAgentProbes.list({
            includeUsage: true,
            providers: [provider],
            refresh: true,
            workspaceId: request.workspaceId
          })
        );
        refreshByProvider.set(provider, refresh);
        void refresh.then(
          (snapshot) => {
            retainedByProvider.set(provider, {
              receivedAtUnixMs: now(),
              snapshot
            });
            if (refreshByProvider.get(provider) === refresh) {
              refreshByProvider.delete(provider);
            }
          },
          () => {
            if (refreshByProvider.get(provider) === refresh) {
              refreshByProvider.delete(provider);
            }
          }
        );
      }

      void refresh.then(
        (snapshot) => {
          if (closed) return;
          observer.onFrame({
            kind: "refreshed",
            value: statusValueFromDesktopProbeSnapshot(request, snapshot)
          });
          observer.onComplete();
        },
        () => {
          if (!closed) {
            observer.onError({ code: "unavailable" });
          }
        }
      );
      return () => {
        closed = true;
      };
    }
  };
}

function resolveDesktopAgentStatusRequest(
  input: DesktopAgentStatusSourceInput,
  query: { agentSessionId?: string | null; scopeKey: string }
):
  | {
      agent: AgentGUIAgent;
      context: Pick<
        AgentStatusValue,
        "agentSessionId" | "contextState" | "contextWindow"
      >;
      workspaceAgentProbes: NonNullable<
        AgentHostInputApi["workspaceAgentProbes"]
      >;
      workspaceId: string;
    }
  | { errorCode: "invalid_target" | "unavailable" } {
  const workspaceId = input.workspaceId.trim();
  const agents =
    typeof input.agents === "function" ? input.agents() : input.agents;
  const agent = agents.find(
    (candidate) => candidate.agentTargetId.trim() === query.scopeKey.trim()
  );
  if (!workspaceId || !agent) {
    return { errorCode: "invalid_target" };
  }
  if (!input.workspaceAgentProbes) {
    return { errorCode: "unavailable" };
  }
  const context = resolveDesktopAgentStatusContext({
    agentActivityRuntime: input.agentActivityRuntime,
    agentSessionId: query.agentSessionId,
    agentTargetId: agent.agentTargetId,
    provider: agent.provider,
    workspaceId
  });
  if (context === null) {
    return { errorCode: "invalid_target" };
  }
  return {
    agent,
    context,
    workspaceAgentProbes: input.workspaceAgentProbes,
    workspaceId
  };
}

function statusValueFromDesktopProbeSnapshot(
  request: {
    agent: AgentGUIAgent;
    context: Pick<
      AgentStatusValue,
      "agentSessionId" | "contextState" | "contextWindow"
    >;
  },
  snapshot: WorkspaceAgentProbeSnapshot
): AgentStatusValue {
  return statusValueFromDesktopProbe(
    request.context,
    snapshot.providers.find(
      (candidate) => candidate.provider === request.agent.provider
    ),
    snapshot.capturedAtUnixMs
  );
}

function pruneDesktopAgentStatusCache(input: {
  lastRefreshAtByProvider: Map<string, number>;
  retainedByProvider: Map<
    string,
    { receivedAtUnixMs: number; snapshot: WorkspaceAgentProbeSnapshot }
  >;
  retainedSnapshotMs: number;
  requestedAt: number;
}): void {
  for (const [provider, retained] of input.retainedByProvider) {
    if (
      input.requestedAt - retained.receivedAtUnixMs >
      input.retainedSnapshotMs
    ) {
      input.retainedByProvider.delete(provider);
    }
  }
  for (const [provider, refreshedAt] of input.lastRefreshAtByProvider) {
    if (input.requestedAt - refreshedAt > input.retainedSnapshotMs) {
      input.lastRefreshAtByProvider.delete(provider);
    }
  }
}

function resolveDesktopAgentStatusContext(input: {
  agentActivityRuntime: AgentGUIProps["agentActivityRuntime"];
  agentSessionId?: string | null;
  agentTargetId: string;
  provider: string;
  workspaceId: string;
}): Pick<
  AgentStatusValue,
  "agentSessionId" | "contextState" | "contextWindow"
> | null {
  const agentSessionId = input.agentSessionId?.trim() ?? "";
  if (!agentSessionId) {
    return {
      agentSessionId: null,
      contextState: "unavailable",
      contextWindow: null
    };
  }
  const session = input.agentActivityRuntime
    .getSnapshot(input.workspaceId)
    .sessions.find((candidate) => candidate.agentSessionId === agentSessionId);
  if (
    !session ||
    session.workspaceId !== input.workspaceId ||
    session.agentTargetId !== input.agentTargetId ||
    session.provider !== input.provider
  ) {
    return null;
  }
  return {
    agentSessionId,
    contextState: session.usage?.contextWindow ? "available" : "unavailable",
    contextWindow: session.usage?.contextWindow ?? null
  };
}

function statusValueFromDesktopProbe(
  context: Pick<
    AgentStatusValue,
    "agentSessionId" | "contextState" | "contextWindow"
  >,
  probe:
    | Awaited<
        ReturnType<
          NonNullable<AgentHostInputApi["workspaceAgentProbes"]>["list"]
        >
      >["providers"][number]
    | undefined,
  snapshotCapturedAtUnixMs: number
): AgentStatusValue {
  const usage = probe?.usage;
  const limitsUnavailable =
    !probe?.lastError || probe.lastError.code === "unsupported";
  const accountLabel = usage?.accountTier?.trim();
  return {
    ...context,
    ...(accountLabel ? { accountLabel } : {}),
    quotas: usage?.quotas ?? [],
    limitsState: usage
      ? "available"
      : limitsUnavailable
        ? "unavailable"
        : "error",
    limitsCapturedAtUnixMs: usage
      ? usage.capturedAtUnixMs || snapshotCapturedAtUnixMs
      : null,
    limitsStale: false
  };
}
