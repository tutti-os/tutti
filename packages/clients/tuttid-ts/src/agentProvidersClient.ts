import {
  getAgentProviderComposerOptions,
  getAgentProviderStatuses,
  probeAgentProvider,
  runAgentProviderAction
} from "./generated/index.ts";
import type { Client } from "./generated/client/index.ts";
import { unwrapData } from "./tuttidClientResponse.ts";
import type { TuttidClient } from "./tuttidClientTypes.ts";

type AgentProvidersClient = Pick<
  TuttidClient,
  | "getAgentProviderComposerOptions"
  | "getAgentProviderStatuses"
  | "probeAgentProvider"
  | "runAgentProviderAction"
>;

export function createAgentProvidersClient(
  client: Client
): AgentProvidersClient {
  return {
    async getAgentProviderComposerOptions(
      provider,
      request = {},
      requestOptions
    ) {
      const response = await getAgentProviderComposerOptions({
        client,
        body: request,
        path: { provider },
        ...requestOptions
      });
      return unwrapData(
        response,
        "Get agent provider composer options request failed."
      );
    },
    async getAgentProviderStatuses(request = {}) {
      const response = await getAgentProviderStatuses({
        client,
        query: request
      });
      return unwrapData(
        response,
        "Get agent provider statuses request failed."
      );
    },
    async probeAgentProvider(provider) {
      const response = await probeAgentProvider({ client, path: { provider } });
      return unwrapData(response, "Probe agent provider request failed.");
    },
    async runAgentProviderAction(provider, actionID) {
      const response = await runAgentProviderAction({
        client,
        path: { actionID, provider }
      });
      return unwrapData(response, "Run agent provider action request failed.");
    }
  };
}
