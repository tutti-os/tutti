import {
  loadAllAgentSessionMessages,
  type AgentActivityAdapter,
  type AgentActivityMessage,
  type AgentActivityMessagePage
} from "@tutti-os/agent-activity-core";
import { reconcileAfterVersion } from "./workspaceAgentActivityDiagnostics.ts";

interface ReconcileAgentSessionMessagePagesInput {
  adapter: AgentActivityAdapter;
  agentSessionId: string;
  cached: AgentActivityMessage[];
  messageWindowKnown: boolean;
  shouldAbort: () => boolean;
  workspaceId: string;
}

export interface InlineMessageVersionContinuity {
  cachedVersion: number;
  continuous: boolean;
  firstUnseenVersion: number | null;
  latestIncomingVersion: number;
}

/**
 * Realtime messages may be folded directly only when they extend the cached
 * per-session change cursor without a hole. Advancing the cache past a missed
 * mutable snapshot would make every later `afterVersion` pull skip that
 * snapshot forever, because message rows retain only their latest version.
 */
export function analyzeInlineMessageVersionContinuity(
  cached: readonly AgentActivityMessage[],
  incoming: readonly AgentActivityMessage[]
): InlineMessageVersionContinuity {
  const cachedVersion = latestMessageVersion(cached);
  const incomingVersions = [
    ...new Set(incoming.map((message) => message.version))
  ].sort((left, right) => left - right);
  const latestIncomingVersion = incomingVersions.at(-1) ?? 0;
  const unseenVersions = incomingVersions.filter(
    (version) => version > cachedVersion
  );
  const versionsAreValid = incomingVersions.every(
    (version) => Number.isSafeInteger(version) && version > 0
  );
  const continuous =
    versionsAreValid &&
    unseenVersions.every(
      (version, index) => version === cachedVersion + index + 1
    );
  return {
    cachedVersion,
    continuous,
    firstUnseenVersion: unseenVersions[0] ?? null,
    latestIncomingVersion
  };
}

export async function reconcileAgentSessionMessagePages(
  input: ReconcileAgentSessionMessagePagesInput
): Promise<AgentActivityMessagePage> {
  if (input.cached.length === 0 || !input.messageWindowKnown) {
    return input.adapter.listSessionMessages({
      workspaceId: input.workspaceId,
      agentSessionId: input.agentSessionId,
      limit: 100,
      order: "desc"
    });
  }

  const afterVersion = reconcileAfterVersion(input.cached);
  const result = await loadAllAgentSessionMessages({
    afterVersion,
    listPage: (cursor) =>
      input.adapter.listSessionMessages({
        workspaceId: input.workspaceId,
        agentSessionId: input.agentSessionId,
        afterVersion: cursor,
        order: "asc"
      }),
    shouldAbort: input.shouldAbort
  });
  return {
    hasMore: false,
    latestVersion: result.messages.reduce(
      (latest, message) => Math.max(latest, message.version),
      afterVersion
    ),
    messages: result.messages
  };
}

function latestMessageVersion(
  messages: readonly AgentActivityMessage[]
): number {
  return messages.reduce(
    (latest, message) => Math.max(latest, message.version),
    0
  );
}
