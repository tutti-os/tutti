export interface AgentConversationParticipantIdentity {
  name: string;
  avatarUrl?: string | null;
}

export type AgentConversationParticipantPresentation =
  | {
      enabled: false;
    }
  | {
      enabled: true;
      status: "loading";
    }
  | {
      enabled: true;
      status: "ready";
      user: AgentConversationParticipantIdentity;
      agent: AgentConversationParticipantIdentity;
    };
