/** Authoritative model default identity for one agent target. */
export interface AgentActivityComposerModelConfiguration {
  agentTargetId: string;
  defaultModel: string | null;
  fingerprint: string;
  source: "model-plan" | "provider-native";
}
