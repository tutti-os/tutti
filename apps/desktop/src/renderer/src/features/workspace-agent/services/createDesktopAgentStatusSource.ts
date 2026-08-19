import type {
  AgentGUIAgent,
  AgentGUIProps,
  AgentHostInputApi,
  AgentStatusSource,
  AgentStatusValue
} from "@tutti-os/agent-gui";
import { translate } from "../../../i18n/appRuntime.ts";

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
          agentTargetIds: [request.agent.agentTargetId],
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
 * Shares exact Agent Target probe work across AgentGUI surfaces without sharing their
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
  const retainedByTarget = new Map<
    string,
    { receivedAtUnixMs: number; snapshot: WorkspaceAgentProbeSnapshot }
  >();
  const refreshByTarget = new Map<
    string,
    Promise<WorkspaceAgentProbeSnapshot>
  >();
  const lastRefreshAtByTarget = new Map<string, number>();

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
        lastRefreshAtByTarget,
        retainedByTarget,
        retainedSnapshotMs,
        requestedAt
      });
      const agentTargetId = request.agent.agentTargetId;
      const retained = retainedByTarget.get(agentTargetId);
      if (retained) {
        observer.onFrame({
          kind: "snapshot",
          value: statusValueFromDesktopProbeSnapshot(request, retained.snapshot)
        });
      }

      let refresh = refreshByTarget.get(agentTargetId);
      const lastRefreshAt = lastRefreshAtByTarget.get(agentTargetId);
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
        lastRefreshAtByTarget.set(agentTargetId, requestedAt);
        refresh = Promise.resolve().then(() =>
          request.workspaceAgentProbes.list({
            agentTargetIds: [agentTargetId],
            includeUsage: true,
            providers: [request.agent.provider],
            refresh: true,
            workspaceId: request.workspaceId
          })
        );
        refreshByTarget.set(agentTargetId, refresh);
        void refresh.then(
          (snapshot) => {
            retainedByTarget.set(agentTargetId, {
              receivedAtUnixMs: now(),
              snapshot
            });
            if (refreshByTarget.get(agentTargetId) === refresh) {
              refreshByTarget.delete(agentTargetId);
            }
          },
          () => {
            if (refreshByTarget.get(agentTargetId) === refresh) {
              refreshByTarget.delete(agentTargetId);
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
      (candidate) =>
        candidate.agentTargetId === request.agent.agentTargetId &&
        candidate.provider === request.agent.provider
    ),
    snapshot.capturedAtUnixMs
  );
}

function pruneDesktopAgentStatusCache(input: {
  lastRefreshAtByTarget: Map<string, number>;
  retainedByTarget: Map<
    string,
    { receivedAtUnixMs: number; snapshot: WorkspaceAgentProbeSnapshot }
  >;
  retainedSnapshotMs: number;
  requestedAt: number;
}): void {
  for (const [agentTargetId, retained] of input.retainedByTarget) {
    if (
      input.requestedAt - retained.receivedAtUnixMs >
      input.retainedSnapshotMs
    ) {
      input.retainedByTarget.delete(agentTargetId);
    }
  }
  for (const [agentTargetId, refreshedAt] of input.lastRefreshAtByTarget) {
    if (input.requestedAt - refreshedAt > input.retainedSnapshotMs) {
      input.lastRefreshAtByTarget.delete(agentTargetId);
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
  const accountLabel =
    usage?.accountTier?.trim() ||
    (usage?.billingMode === "api"
      ? translate("workspace.agentEnv.apiUsageBilling")
      : "");
  const limitsErrorCode =
    probe?.lastError?.code === "unsupported"
      ? ""
      : probe?.lastError?.code?.trim() || "";
  return {
    ...context,
    ...(accountLabel ? { accountLabel } : {}),
    quotas: usage?.quotas ?? [],
    limitsState: limitsErrorCode
      ? "error"
      : usage
        ? "available"
        : "unavailable",
    ...(limitsErrorCode ? { limitsErrorCode } : {}),
    limitsCapturedAtUnixMs: usage
      ? usage.capturedAtUnixMs || snapshotCapturedAtUnixMs
      : null,
    limitsStale: false
  };
}
