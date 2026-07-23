import { describe, expect, it } from "vitest";
import type {
  AgentConversationFlowProps,
  AgentConversationParticipantPresentation,
  AgentTranscriptViewProps,
  WorkspaceAgentSessionDetailProps
} from "./index";

const presentation: AgentConversationParticipantPresentation = {
  enabled: true,
  status: "ready",
  user: {
    name: "Alice",
    avatarUrl: "https://example.test/alice.png"
  },
  agent: {
    name: "Codex",
    avatarUrl: "https://example.test/codex.png"
  }
};

const detailPresentation: WorkspaceAgentSessionDetailProps["participantPresentation"] =
  presentation;
const flowPresentation: AgentConversationFlowProps["participantPresentation"] =
  presentation;
const transcriptPresentation: AgentTranscriptViewProps["participantPresentation"] =
  presentation;

describe("agent-conversation public contract", () => {
  it("shares one participant presentation contract across public transcript entrypoints", () => {
    expect(detailPresentation).toBe(presentation);
    expect(flowPresentation).toBe(presentation);
    expect(transcriptPresentation).toBe(presentation);
  });
});
