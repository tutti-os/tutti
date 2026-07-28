import {
  AGENT_SESSION_ENGINE_LOCAL_ORIGIN,
  createAgentSessionEngine,
  selectSessionMessages
} from "@tutti-os/agent-activity-core";
import type {
  TuttidClient,
  WorkspaceAgentSessionMessage,
  WorkspaceAgentSessionMessagesResponse
} from "@tutti-os/client-tuttid-ts";
import { WorkspaceActivityMessagePageLoader } from "./workspaceActivityMessagePageLoader";

describe("WorkspaceActivityMessagePageLoader", () => {
  test("deduplicates only the exact query while allowing a different page to run", async () => {
    const requests: Array<{
      deferred: Deferred<WorkspaceAgentSessionMessagesResponse>;
      query: Record<string, unknown>;
    }> = [];
    const harness = createHarness({
      listMessages: async (_workspaceId, _agentSessionId, query) => {
        const request = {
          deferred: deferred<WorkspaceAgentSessionMessagesResponse>(),
          query
        };
        requests.push(request);
        return request.deferred.promise;
      }
    });

    const newestA = harness.loader.loadPage("session-1", {
      limit: 100,
      order: "desc"
    });
    const newestB = harness.loader.loadPage("session-1", {
      limit: 100,
      order: "desc"
    });
    const older = harness.loader.loadPage("session-1", {
      beforeVersion: 5,
      limit: 100,
      order: "desc"
    });

    expect(newestA).toBe(newestB);
    expect(requests.map((request) => request.query)).toEqual([
      { limit: 100, order: "desc" },
      { beforeVersion: 5, limit: 100, order: "desc" }
    ]);

    requests[0]!.deferred.resolve(messagePage("message-5", 5));
    requests[1]!.deferred.resolve(messagePage("message-2", 2));
    await Promise.all([newestA, older]);

    expect(
      selectSessionMessages(harness.engine.getSnapshot(), "session-1").map(
        (message) => message.version
      )
    ).toEqual([2, 5]);
    expect(harness.appliedSessionIds).toEqual(["session-1", "session-1"]);
    expect(harness.settledCount()).toBe(2);
    harness.engine.dispose();
  });

  test("drops a late page when the host becomes unavailable", async () => {
    const request = deferred<WorkspaceAgentSessionMessagesResponse>();
    let available = true;
    const harness = createHarness({
      isAvailable: () => available,
      listMessages: async () => request.promise
    });

    const load = harness.loader.loadPage("session-1", {
      limit: 100,
      order: "desc"
    });
    available = false;
    request.resolve(messagePage("message-5", 5));
    await load;

    expect(
      selectSessionMessages(harness.engine.getSnapshot(), "session-1")
    ).toEqual([]);
    expect(harness.appliedSessionIds).toEqual([]);
    expect(harness.failedErrors).toEqual([]);
    expect(harness.settledCount()).toBe(1);
    harness.engine.dispose();
  });

  test("clears a failed request so the exact query can be retried", async () => {
    const failure = new Error("message page unavailable");
    let attempts = 0;
    const harness = createHarness({
      listMessages: async () => {
        attempts += 1;
        if (attempts === 1) throw failure;
        return messagePage("message-7", 7);
      }
    });
    const query = { afterVersion: 5, order: "asc" as const };

    await expect(harness.loader.loadPage("session-1", query)).rejects.toBe(
      failure
    );
    await harness.loader.loadPage("session-1", query);

    expect(attempts).toBe(2);
    expect(harness.failedErrors).toEqual([failure]);
    expect(harness.settledCount()).toBe(2);
    expect(
      selectSessionMessages(harness.engine.getSnapshot(), "session-1").map(
        (message) => message.version
      )
    ).toEqual([7]);
    harness.engine.dispose();
  });
});

function createHarness(input: {
  isAvailable?: () => boolean;
  listMessages(
    workspaceId: string,
    agentSessionId: string,
    query: Record<string, unknown>
  ): Promise<WorkspaceAgentSessionMessagesResponse>;
}) {
  const engine = createAgentSessionEngine({
    clock: { nowUnixMs: () => 1 },
    commandPort: { execute: async () => ({}) },
    identity: {
      origin: AGENT_SESSION_ENGINE_LOCAL_ORIGIN,
      workspaceId: "workspace-1"
    },
    scheduler: {
      schedule: () => ({ cancel: () => undefined })
    }
  });
  const appliedSessionIds: string[] = [];
  const failedErrors: unknown[] = [];
  let settled = 0;
  const client = {
    listWorkspaceAgentSessionMessages: input.listMessages
  } as Pick<TuttidClient, "listWorkspaceAgentSessionMessages">;
  const loader = new WorkspaceActivityMessagePageLoader({
    client,
    engine,
    isAvailable: input.isAvailable ?? (() => true),
    onPageApplied: (agentSessionId) => {
      appliedSessionIds.push(agentSessionId);
    },
    onRequestFailed: (error) => {
      failedErrors.push(error);
    },
    onRequestSettled: () => {
      settled += 1;
    },
    workspaceId: "workspace-1"
  });
  return {
    appliedSessionIds,
    engine,
    failedErrors,
    loader,
    settledCount: () => settled
  };
}

function messagePage(
  messageId: string,
  version: number
): WorkspaceAgentSessionMessagesResponse {
  return {
    agentSessionId: "session-1",
    hasMore: false,
    latestVersion: version,
    messages: [message(messageId, version)]
  };
}

function message(
  messageId: string,
  version: number
): WorkspaceAgentSessionMessage {
  return {
    agentSessionId: "session-1",
    kind: "text",
    messageId,
    occurredAtUnixMs: version,
    payload: { text: messageId },
    role: "assistant",
    sequence: version,
    turnId: "turn-1",
    version
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  reject(error: unknown): void;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let reject!: (error: unknown) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}
