import type {
  AgentProviderStatus,
  WorkspaceAgentProvider
} from "@tutti-os/client-tuttid-ts";
import {
  deriveAgentSetupStages,
  projectRevealedStages,
  reasonCodeIndicatesCliVersionUnsupported,
  type AgentSetupStage,
  type AgentSetupStageId,
  type AgentSetupStageLabels,
  type StageDetailToken
} from "./agentEnvWizardFlow.ts";
import type {
  CodexSetupActiveAction,
  CodexSetupActiveActionError,
  CodexSetupPhase
} from "./codexSetupContract.ts";

export interface NetworkCheck {
  kind: "registry" | "api" | "proxy";
  reachable: boolean;
  host: string | null;
  configured?: boolean;
}

const MANUAL_INSTALL_COMMANDS: Partial<Record<WorkspaceAgentProvider, string>> =
  {
    codex: "npm install -g @openai/codex --include=optional",
    "claude-code": "curl -fsSL https://claude.ai/install.sh | bash"
  };

function endpointHost(endpoint: string | null | undefined): string | null {
  if (!endpoint) {
    return null;
  }
  return endpoint.replace(/^https?:\/\//, "").replace(/\/.*$/, "") || null;
}

// A proxy URL may carry credentials (http://user:pass@host:port). Strip the
// userinfo before it reaches the renderer/UI so proxy passwords are never
// surfaced; the scheme + host:port are kept for display.
function scrubProxyUrl(url: string | null | undefined): string | null {
  if (!url) {
    return null;
  }
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    // Not a parseable URL — still strip a leading userinfo segment defensively.
    return url.replace(/\/\/[^/@]*@/, "//") || null;
  }
}

function textToken(text: string | null): StageDetailToken | null {
  return text ? { kind: "text", text } : null;
}

function joinDetail(parts: Array<string | null | undefined>): string | null {
  const joined = parts.filter((p): p is string => Boolean(p)).join(" · ");
  return joined || null;
}

export function deriveHasAnomaly(
  stages: AgentSetupStage[],
  activeActionError: CodexSetupActiveActionError | null
): boolean {
  return stages.some((s) => s.status === "error") || Boolean(activeActionError);
}

export interface AgentEnvWizardViewModelInput {
  provider: WorkspaceAgentProvider;
  status: AgentProviderStatus | null;
  isLoading: boolean;
  activeAction: CodexSetupActiveAction | null;
  installActionPending: boolean;
  loginPending: boolean;
  revealIndex: number;
  stageLabels: AgentSetupStageLabels;
}

export interface AgentEnvWizardViewModel {
  ready: boolean;
  busy: boolean;
  redetecting: boolean;
  displayStages: AgentSetupStage[];
  blockingStageId: AgentSetupStageId | null;
  networkChecks: NetworkCheck[];
  hasAnomaly: boolean;
  activePhase: CodexSetupPhase | null;
  log: string[];
  registry: string | null;
  error: CodexSetupActiveActionError | null;
  manualCommand: string | null;
  installPending: boolean;
  loginPending: boolean;
}

export function buildAgentEnvWizardViewModel(
  input: AgentEnvWizardViewModelInput
): AgentEnvWizardViewModel {
  const { status, activeAction, provider } = input;
  const ready = status?.availability.status === "ready";
  const installPending = input.installActionPending;
  const loginPending = input.loginPending;
  const busy =
    installPending ||
    activeAction?.phase === "install" ||
    activeAction?.phase === "repair" ||
    activeAction?.phase === "verify";

  const reasonCode = (status?.availability.reasonCode ?? "").toLowerCase();
  const versionTooOld = reasonCodeIndicatesCliVersionUnsupported(reasonCode);
  const cliBelowFloor = reasonCode.includes("codex_version_too_old");
  // The codex launcher is present but its platform subpackage is missing — the
  // CLI spawns ENOENT. The daemon repairs this in place via the install action;
  // the wizard must NOT mark the install stage ok just because the launcher
  // resolved.
  const platformPackageIncomplete = reasonCode.includes(
    "codex_platform_pkg_incomplete"
  );
  const adapterVersionMismatch = reasonCode.includes(
    "acp_adapter_version_mismatch"
  );

  const cliDetail: StageDetailToken | null =
    cliBelowFloor && status?.cli.version && status.cli.minVersion
      ? {
          kind: "version-floor",
          current: status.cli.version,
          required: status.cli.minVersion
        }
      : status?.cli.installed
        ? textToken(joinDetail([status?.cli.version, status?.cli.binaryPath]))
        : textToken(status?.cli.version ?? null);

  const adapterDetail: StageDetailToken | null =
    adapterVersionMismatch &&
    status?.adapter.version &&
    status?.adapter.requiredVersion
      ? {
          kind: "version-mismatch",
          current: status.adapter.version,
          required: status.adapter.requiredVersion
        }
      : status?.adapter.installed
        ? textToken(
            joinDetail([status?.adapter.version, status?.adapter.binaryPath])
          )
        : textToken(
            status?.adapter.binaryPath ??
              (status?.adapter.command?.length
                ? status.adapter.command.join(" ")
                : null)
          );

  const networkChecks: NetworkCheck[] = status?.network
    ? [
        {
          kind: "registry",
          reachable: status.network.registry.reachable,
          host: endpointHost(status.network.registry.endpoint)
        },
        ...(status.network.providerApi
          ? [
              {
                kind: "api" as const,
                reachable: status.network.providerApi.reachable,
                host: endpointHost(status.network.providerApi.endpoint)
              }
            ]
          : []),
        ...(status.network.proxy
          ? [
              {
                kind: "proxy" as const,
                reachable:
                  !status.network.proxy.configured ||
                  status.network.proxy.reachable,
                host: scrubProxyUrl(status.network.proxy.url),
                configured: status.network.proxy.configured
              }
            ]
          : [])
      ]
    : [];
  const networkReachable =
    networkChecks.length === 0 ? null : networkChecks.every((c) => c.reachable);

  const accountDetail: StageDetailToken | null = status?.auth.accountLabel
    ? { kind: "text", text: status.auth.accountLabel }
    : status?.auth.status === "authenticated"
      ? { kind: "text", text: "__SIGNED_IN__" }
      : null;
  const authMethod: string | null = status?.auth.authMethod ?? null;

  const stages = deriveAgentSetupStages({
    detected: status !== null,
    cliInstalled: status?.cli.installed ?? false,
    versionTooOld,
    platformPackageIncomplete,
    adapterInstalled: status?.adapter.installed ?? false,
    adapterVersionMismatch,
    authenticated: status?.auth.status === "authenticated",
    authRequired: status?.auth.status === "required",
    ready: Boolean(ready),
    activePhase: activeAction?.phase ?? null,
    installActionPending: installPending,
    loginPending,
    networkReachable,
    cliVersionDetail: cliDetail,
    adapterDetail,
    accountDetail,
    authMethod,
    networkDetail: null,
    labels: input.stageLabels
  });

  const registry = activeAction?.registry ?? null;
  const stagesWithDetail = registry
    ? stages.map((s) =>
        s.id === "ready"
          ? { ...s, detail: { kind: "text" as const, text: registry } }
          : s
      )
    : stages;
  const displayStages = projectRevealedStages(
    stagesWithDetail,
    input.revealIndex
  );

  const blockingIndex = stages.findIndex((s) => s.status !== "ok");
  const blockingStage = blockingIndex >= 0 ? stages[blockingIndex] : undefined;
  const blockingStageId: AgentSetupStageId | null =
    blockingStage && input.revealIndex >= blockingIndex
      ? blockingStage.id
      : null;

  return {
    ready: Boolean(ready),
    busy: Boolean(busy),
    redetecting: input.isLoading,
    displayStages,
    blockingStageId,
    networkChecks,
    hasAnomaly: deriveHasAnomaly(stages, activeAction?.error ?? null),
    activePhase: activeAction?.phase ?? null,
    log: activeAction?.log ?? [],
    registry,
    error: activeAction?.error ?? null,
    manualCommand: MANUAL_INSTALL_COMMANDS[provider] ?? null,
    installPending,
    loginPending
  };
}
