import {
  createAgentActivitySessionReconcileExecutor,
  type AgentActivitySessionReconcileExecutor,
  type AgentSessionEngine
} from "@tutti-os/agent-activity-core";
import type { TuttidClient } from "@tutti-os/client-tuttid-ts";
import type { MobileAgentActivityMapping } from "./mobileAgentActivityMapping";

export function createMobileAgentActivityReconcileExecutor(input: {
  client: Pick<
    TuttidClient,
    "getWorkspaceAgentSession" | "listWorkspaceAgentSessionMessages"
  >;
  engine: Pick<AgentSessionEngine, "dispatch" | "getSnapshot">;
  isAvailable(): boolean;
  isSessionDeleted(agentSessionId: string): boolean;
  mapping: MobileAgentActivityMapping;
  reconcileOptimisticMessages(agentSessionId: string): void;
  workspaceId: string;
}): AgentActivitySessionReconcileExecutor {
  return createAgentActivitySessionReconcileExecutor({
    childMessageHydration: "requested_session",
    engine: input.engine,
    isAvailable: input.isAvailable,
    isSessionDeleted: input.isSessionDeleted,
    port: {
      getSessionDetail: async ({ agentSessionId, signal }) =>
        input.mapping.mapSessionDetail(
          agentSessionId,
          await input.client.getWorkspaceAgentSession(
            input.workspaceId,
            agentSessionId,
            { signal }
          )
        ),
      listSessionMessages: async ({
        afterVersion,
        agentSessionId,
        beforeVersion,
        limit,
        order,
        signal
      }) => {
        const page = await input.client.listWorkspaceAgentSessionMessages(
          input.workspaceId,
          agentSessionId,
          {
            ...(afterVersion === undefined ? {} : { afterVersion }),
            ...(beforeVersion === undefined ? {} : { beforeVersion }),
            ...(limit === undefined ? {} : { limit }),
            ...(order === undefined ? {} : { order })
          },
          { signal }
        );
        return {
          ...page,
          messages: page.messages.map(input.mapping.mapMessage)
        };
      }
    },
    reconcileOptimisticMessages: input.reconcileOptimisticMessages,
    workspaceId: input.workspaceId
  });
}
