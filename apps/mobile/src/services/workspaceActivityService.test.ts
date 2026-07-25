import type {
  TuttidClient,
  WorkspaceAgentSession,
  WorkspaceAgentSessionMessage,
  WorkspaceSummary
} from "@tutti-os/client-tuttid-ts";
import { AgentDirectoryService } from "./agentDirectoryService";
import { ComposerDraftService } from "./composerDraftService";
import type { ClockPort } from "./servicePorts";
import { WorkspaceActivityService } from "./workspaceActivityService";
import { WorkspaceNavigationService } from "./workspaceNavigationService";

const workspace: WorkspaceSummary = {
  id: "workspace-1",
  lastOpenedAt: null,
  name: "Workspace"
};

describe("WorkspaceActivityService", () => {
  test("projects canonical session identity and authoritative message paging", async () => {
    const messageQueries: Array<Record<string, unknown>> = [];
    const client = createClient({
      listMessages: async (_workspaceId, agentSessionId, query) => {
        messageQueries.push(query);
        const older = "beforeVersion" in query;
        return {
          agentSessionId,
          hasMore: !older,
          latestVersion: 7,
          messages: [
            createMessage(
              older ? "message-older" : "message-latest",
              older ? 3 : 7
            )
          ]
        };
      }
    });
    const service = createService(client);

    await service.start();
    await flushAsyncWork();

    const initial = service.getSnapshot();
    expect(initial.selectedAgentSessionId).toBe("session-1");
    expect(initial.selectedSession?.userId).toBe("account-user-1");
    expect(
      initial.activity.sessionMessagesById["session-1"]?.map(
        (message) => message.messageId
      )
    ).toEqual(["message-latest"]);
    expect(messageQueries[0]).toEqual({ limit: 100, order: "desc" });

    await service.loadOlderMessages();
    await flushAsyncWork();

    expect(messageQueries[1]).toEqual({
      beforeVersion: 7,
      limit: 100,
      order: "desc"
    });
    expect(
      service
        .getSnapshot()
        .activity.sessionMessagesById["session-1"]?.map(
          (message) => message.messageId
        )
    ).toEqual(["message-older", "message-latest"]);

    service.dispose();
  });

  test("routes an existing-session submission through the engine command port", async () => {
    const sends: Array<{
      agentSessionId: string;
      input: Record<string, unknown>;
      workspaceId: string;
    }> = [];
    const client = createClient({
      listMessages: async (_workspaceId, agentSessionId) => ({
        agentSessionId,
        hasMore: false,
        latestVersion: 0,
        messages: []
      }),
      send: async (workspaceId, agentSessionId, input) => {
        sends.push({ agentSessionId, input, workspaceId });
        return new Promise<never>(() => undefined);
      }
    });
    const service = createService(client);

    await service.start();
    await flushAsyncWork();
    service.setDraft("continue");
    await service.send();
    await flushAsyncWork();

    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({
      agentSessionId: "session-1",
      input: {
        content: [{ text: "continue", type: "text" }]
      },
      workspaceId: "workspace-1"
    });
    expect(service.getSnapshot().draft).toBe("");
    expect(service.getSnapshot().sending).toBe(true);

    service.dispose();
  });
});

function createService(client: TuttidClient): WorkspaceActivityService {
  return new WorkspaceActivityService(
    workspace,
    client,
    new AgentDirectoryService(client),
    new WorkspaceNavigationService(),
    new ComposerDraftService(),
    new ManualClock(),
    "account-user-1"
  );
}

function createClient(options: {
  listMessages(
    workspaceId: string,
    agentSessionId: string,
    query: Record<string, unknown>
  ): Promise<{
    agentSessionId: string;
    hasMore: boolean;
    latestVersion: number;
    messages: WorkspaceAgentSessionMessage[];
  }>;
  send?(
    workspaceId: string,
    agentSessionId: string,
    input: Record<string, unknown>
  ): Promise<never>;
}): TuttidClient {
  return {
    listAgentTargets: async () => ({ targets: [] }),
    listWorkspaceAgentSessionMessages: options.listMessages,
    listWorkspaceAgentSessions: async () => ({
      hasMore: false,
      sessions: [createSession()],
      workspaceId: workspace.id
    }),
    sendWorkspaceAgentSessionInput: options.send
  } as unknown as TuttidClient;
}

function createSession(): WorkspaceAgentSession {
  return {
    activeTurn: null,
    activeTurnId: null,
    agentTargetId: null,
    capabilities: null,
    createdAtUnixMs: 1,
    cwd: "/",
    endedAtUnixMs: null,
    goal: null,
    id: "session-1",
    imported: false,
    kind: "root",
    latestTurn: null,
    latestTurnInteractions: [],
    parentAgentSessionId: null,
    parentToolCallId: null,
    parentTurnId: null,
    pendingInteractions: [],
    permissionConfig: { configurable: false, modes: [] },
    pinnedAtUnixMs: null,
    provider: "codex",
    providerSessionId: null,
    railSectionKey: "conversations",
    resumable: true,
    rootAgentSessionId: null,
    rootTurnId: null,
    settings: {},
    title: "Session",
    tuttiModeActivation: null,
    updatedAtUnixMs: 2,
    usage: null,
    visible: true
  };
}

function createMessage(
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

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

class ManualClock implements ClockPort {
  now(): number {
    return 1_000;
  }

  schedule(): { cancel(): void } {
    return { cancel: () => undefined };
  }
}
