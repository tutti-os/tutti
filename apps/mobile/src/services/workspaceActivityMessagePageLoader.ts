import {
  agentActivitySessionMessageWindowFromDescendingPage,
  type AgentSessionEngine
} from "@tutti-os/agent-activity-core";
import { agentActivityMessageFromTuttidMessage } from "@tutti-os/agent-activity-tuttid-adapter";
import type { TuttidClient } from "@tutti-os/client-tuttid-ts";

export interface WorkspaceActivityMessagePageQuery {
  afterVersion?: number;
  beforeVersion?: number;
  limit?: number;
  order: "asc" | "desc";
}

interface WorkspaceActivityMessagePageLoaderDependencies {
  client: Pick<TuttidClient, "listWorkspaceAgentSessionMessages">;
  engine: AgentSessionEngine;
  isAvailable(): boolean;
  onPageApplied(agentSessionId: string): void;
  onRequestFailed(error: unknown): void;
  onRequestSettled(): void;
  workspaceId: string;
}

/**
 * Owns transport-page concurrency and canonical Engine application for Mobile
 * message reads. Polling cadence and authoritative-vs-incremental selection
 * remain WorkspaceActivityService lifecycle decisions.
 */
export class WorkspaceActivityMessagePageLoader {
  private readonly requestsInFlightByKey = new Map<string, Promise<void>>();

  constructor(
    private readonly dependencies: WorkspaceActivityMessagePageLoaderDependencies
  ) {}

  loadPage(
    agentSessionId: string,
    query: WorkspaceActivityMessagePageQuery
  ): Promise<void> {
    if (!this.dependencies.isAvailable()) return Promise.resolve();
    const requestKey = messageRequestKey(agentSessionId, query);
    const existing = this.requestsInFlightByKey.get(requestKey);
    if (existing) return existing;

    const request = this.dependencies.client
      .listWorkspaceAgentSessionMessages(
        this.dependencies.workspaceId,
        agentSessionId,
        query
      )
      .then((page) => {
        if (!this.dependencies.isAvailable()) return;
        const messages = page.messages.map((message) =>
          agentActivityMessageFromTuttidMessage(
            this.dependencies.workspaceId,
            message
          )
        );
        this.dependencies.engine.dispatch({
          messages,
          ...(query.order === "desc"
            ? {
                sessionMessageWindows: [
                  {
                    agentSessionId,
                    ...agentActivitySessionMessageWindowFromDescendingPage({
                      ...page,
                      messages
                    })
                  }
                ]
              }
            : {}),
          type: "message/snapshotReceived",
          workspaceId: this.dependencies.workspaceId
        });
        this.dependencies.onPageApplied(agentSessionId);
      })
      .catch((error: unknown) => {
        this.dependencies.onRequestFailed(error);
        throw error;
      })
      .finally(() => {
        if (this.requestsInFlightByKey.get(requestKey) === request) {
          this.requestsInFlightByKey.delete(requestKey);
        }
        this.dependencies.onRequestSettled();
      });
    this.requestsInFlightByKey.set(requestKey, request);
    return request;
  }
}

function messageRequestKey(
  agentSessionId: string,
  query: WorkspaceActivityMessagePageQuery
): string {
  return JSON.stringify([
    agentSessionId,
    query.order,
    query.afterVersion ?? null,
    query.beforeVersion ?? null,
    query.limit ?? null
  ]);
}
