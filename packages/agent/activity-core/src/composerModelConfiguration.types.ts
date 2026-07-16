export interface AgentActivityComposerModelConfiguration {
  agentTargetId: string;
  defaultModel: string | null;
  fingerprint: string;
  source: "model-plan" | "provider-native";
}
