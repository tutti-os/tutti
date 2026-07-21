import type {
  AgentGUIAgent,
  AgentGUIProps,
  AgentHostInputApi,
  AgentStatusSource,
  AgentStatusValue
} from "@tutti-os/agent-gui";

interface DesktopAgentStatusSourceInput {
  agentActivityRuntime: AgentGUIProps["agentActivityRuntime"];
  agents: readonly AgentGUIAgent[];
  workspaceAgentProbes: AgentHostInputApi["workspaceAgentProbes"];
  workspaceId: string;
}

/**
 * Adapts Desktop's canonical activity/probe ports to AgentGUI's bounded status
 * source. Target and Session identity are resolved here at the host boundary;
 * AgentGUI never infers a provider from an opaque target id.
 */
export function createDesktopAgentStatusSource(
  input: DesktopAgentStatusSourceInput
): AgentStatusSource {
  const workspaceId = input.workspaceId.trim();
  const agentsByTargetId = new Map(
    input.agents.map((agent) => [agent.agentTargetId.trim(), agent] as const)
  );

  return {
    open(query, observer) {
      let closed = false;
      const agent = agentsByTargetId.get(query.scopeKey.trim());
      if (!workspaceId || !agent || !input.workspaceAgentProbes) {
        observer.onError({
          code: agent && workspaceId ? "unavailable" : "invalid_target"
        });
        return () => {
          closed = true;
        };
      }

      const context = resolveDesktopAgentStatusContext({
        agentActivityRuntime: input.agentActivityRuntime,
        agentSessionId: query.agentSessionId,
        agentTargetId: agent.agentTargetId,
        provider: agent.provider,
        workspaceId
      });
      if (context === null) {
        observer.onError({ code: "invalid_target" });
        return () => {
          closed = true;
        };
      }

      void input.workspaceAgentProbes
        .list({
          includeUsage: true,
          providers: [agent.provider],
          refresh: true,
          workspaceId
        })
        .then((snapshot) => {
          if (closed) return;
          const probe = snapshot.providers.find(
            (candidate) => candidate.provider === agent.provider
          );
          observer.onFrame({
            kind: "refreshed",
            value: statusValueFromDesktopProbe(
              context,
              probe,
              snapshot.capturedAtUnixMs
            )
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
  return {
    ...context,
    quotas: usage?.quotas ?? [],
    limitsState: usage
      ? "available"
      : probe?.lastError
        ? "error"
        : "unavailable",
    limitsCapturedAtUnixMs: usage
      ? usage.capturedAtUnixMs || snapshotCapturedAtUnixMs
      : null,
    limitsStale: false
  };
}
