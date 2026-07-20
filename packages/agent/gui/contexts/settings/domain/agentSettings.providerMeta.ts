import { resolveAgentGUIProviderCatalogIdentity } from "../../../providerIdentityCatalog.ts";
import {
  AGENT_PROVIDERS,
  type AgentProvider
} from "./agentSettings.providers.ts";

export const AGENT_PROVIDER_LABEL = Object.fromEntries(
  AGENT_PROVIDERS.map((provider) => {
    const identity = resolveAgentGUIProviderCatalogIdentity(provider);
    if (!identity) {
      throw new Error(`Missing provider identity for ${provider}`);
    }
    return [provider, identity.displayName];
  })
) as Record<AgentProvider, string>;

export interface AgentProviderCapabilities {
  runtimeObservation: "jsonl" | "provider-api" | "none";
  experimental: boolean;
}

export const AGENT_PROVIDER_CAPABILITIES: Record<
  AgentProvider,
  AgentProviderCapabilities
> = {
  "claude-code": {
    runtimeObservation: "jsonl",
    experimental: false
  },
  codex: {
    runtimeObservation: "jsonl",
    experimental: false
  },
  "tutti-agent": {
    runtimeObservation: "provider-api",
    experimental: false
  },
  cursor: {
    runtimeObservation: "jsonl",
    experimental: false
  },
  nexight: {
    runtimeObservation: "jsonl",
    experimental: false
  },
  opencode: {
    runtimeObservation: "provider-api",
    experimental: false
  },
  openclaw: {
    runtimeObservation: "jsonl",
    experimental: false
  },
  hermes: {
    runtimeObservation: "jsonl",
    experimental: false
  }
};
