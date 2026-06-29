import type { AgentProviderStatus } from "@tutti-os/client-tuttid-ts";
import type { AgentEnvDetectedParams } from "../../../analytics/reporters/agent-env-detected/types.ts";
import type { AgentEnvIssueReportedParams } from "../../../analytics/reporters/agent-env-issue-reported/types.ts";

function networkApiStatusOf(status: AgentProviderStatus): string {
  const network = status.network;
  if (!network) {
    return "unknown";
  }
  // A null providerApi means the probe was skipped (no known endpoint, or the
  // CLI uses a custom API key/endpoint).
  if (!network.providerApi) {
    return "skipped";
  }
  return network.providerApi.reachable ? "reachable" : "unreachable";
}

/**
 * Privacy-safe summary of a provider's environment detection — booleans, enums,
 * and the CLI version only. No file paths (they carry the username), no account
 * email, no proxy address/registry URL.
 */
export function buildEnvDetectedParams(
  status: AgentProviderStatus
): AgentEnvDetectedParams {
  const network = status.network ?? null;
  return {
    provider: status.provider,
    availabilityStatus: status.availability.status,
    reasonCode: status.availability.reasonCode ?? "",
    cliInstalled: status.cli.installed,
    cliVersion: status.cli.version ?? "",
    adapterInstalled: status.adapter.installed,
    adapterVersion: status.adapter.version ?? "",
    adapterRequiredVersion: status.adapter.requiredVersion ?? "",
    authenticated: status.auth.status === "authenticated",
    networkRegistryReachable: network?.registry.reachable ?? null,
    networkApiStatus: networkApiStatusOf(status),
    networkProxyConfigured: network?.proxy?.configured ?? null,
    networkProxyReachable: network?.proxy ? network.proxy.reachable : null
  };
}

/**
 * A stable fingerprint of the privacy-safe summary, used to fire the
 * `agent.env_detected` event only when the detection outcome actually changes
 * (so routine status polling doesn't spam the funnel).
 */
export function envDetectedSignature(status: AgentProviderStatus): string {
  const params = buildEnvDetectedParams(status);
  return JSON.stringify([
    params.availabilityStatus,
    params.reasonCode,
    params.cliInstalled,
    params.cliVersion,
    params.adapterInstalled,
    params.adapterVersion,
    params.adapterRequiredVersion,
    params.authenticated,
    params.networkRegistryReachable,
    params.networkApiStatus,
    params.networkProxyConfigured,
    params.networkProxyReachable
  ]);
}

/**
 * The fuller, consent-gated payload for the "report problem" button: the safe
 * summary plus the diagnostic detail (paths, endpoints, proxy address) that
 * helps debugging but is more revealing — hence only sent after the user agrees.
 * Still omits the account email as too private even under consent.
 */
export function buildEnvIssueParams(
  status: AgentProviderStatus
): AgentEnvIssueReportedParams {
  const network = status.network ?? null;
  return {
    ...buildEnvDetectedParams(status),
    consentGiven: true,
    cliPath: status.cli.binaryPath ?? "",
    adapterTarget:
      status.adapter.binaryPath ?? status.adapter.command.join(" "),
    accountPresent:
      Boolean(status.auth.accountLabel) ||
      status.auth.status === "authenticated",
    registryEndpoint: network?.registry.endpoint ?? "",
    apiEndpoint: network?.providerApi?.endpoint ?? "",
    proxyUrl: network?.proxy?.url ?? ""
  };
}
