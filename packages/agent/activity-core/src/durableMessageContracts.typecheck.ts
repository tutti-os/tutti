import type {
  AgentActivityMessagePage,
  AgentActivityMessageUpdatedEvent
} from "./types.ts";

const messageWithoutSequence = {
  agentSessionId: "session-1",
  kind: "text",
  messageId: "message-1",
  occurredAtUnixMs: 1,
  payload: {},
  role: "assistant",
  turnId: "turn-1",
  version: 1
};

const invalidPage: AgentActivityMessagePage = {
  hasMore: false,
  latestVersion: 1,
  // @ts-expect-error daemon pages contain durable messages with an immutable sequence
  messages: [messageWithoutSequence]
};

const invalidUpdate: AgentActivityMessageUpdatedEvent = {
  agentSessionId: "session-1",
  data: {
    acceptedCount: 1,
    agentSessionId: "session-1",
    eventType: "message_update",
    latestVersion: 1,
    // @ts-expect-error message_update contains durable messages with an immutable sequence
    messages: [messageWithoutSequence],
    workspaceId: "workspace-1"
  },
  eventType: "message_update",
  workspaceId: "workspace-1"
};

void invalidPage;
void invalidUpdate;
