import type { AgentTarget, TuttidClient } from "@tutti-os/client-tuttid-ts";
import type {
  AgentGUIProvider,
  AgentGUIProviderTarget,
  AgentGUIProviderTargetRef
} from "@tutti-os/agent-gui";
import type {
  AgentsSnapshot,
  AgentTargetPresentation,
  IAgentsService
} from "../agentsService.interface.ts";

export interface DesktopAgentsServiceDependencies {
  now?: () => number;
  resolveAgentIconUrl?: (provider: string) => string;
  /** Feature gate: gated providers keep their targets but are forced disabled (coming soon). */
  isAgentTargetProviderGated?: (provider: string) => boolean;
  tuttidClient: Pick<TuttidClient, "listAgentTargets">;
}

const EMPTY_AGENTS_SNAPSHOT: AgentsSnapshot = Object.freeze({
  agentTargets: Object.freeze([]),
  capturedAtUnixMs: null,
  providerTargets: Object.freeze([])
});

export class DesktopAgentsService implements IAgentsService {
  readonly _serviceBrand = undefined;

  private readonly dependencies: DesktopAgentsServiceDependencies;
  private readonly listeners = new Set<() => void>();
  private loadPromise: Promise<AgentsSnapshot> | null = null;
  private snapshot: AgentsSnapshot = EMPTY_AGENTS_SNAPSHOT;

  constructor(dependencies: DesktopAgentsServiceDependencies) {
    this.dependencies = dependencies;
  }

  getSnapshot(): AgentsSnapshot {
    return this.snapshot;
  }

  getAgentTarget(input: {
    agentTargetId: string;
  }): AgentTargetPresentation | null {
    const agentTargetId = input.agentTargetId.trim();
    if (!agentTargetId) {
      return null;
    }
    return (
      this.snapshot.agentTargets.find(
        (target) => target.agentTargetId === agentTargetId
      ) ?? null
    );
  }

  load(signal?: AbortSignal): Promise<AgentsSnapshot> {
    if (!this.loadPromise) {
      this.loadPromise = this.fetchSnapshot(signal).finally(() => {
        this.loadPromise = null;
      });
    }
    return this.loadPromise;
  }

  refresh(signal?: AbortSignal): Promise<AgentsSnapshot> {
    this.loadPromise = null;
    return this.fetchSnapshot(signal);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private async fetchSnapshot(signal?: AbortSignal): Promise<AgentsSnapshot> {
    if (signal?.aborted) {
      return this.snapshot;
    }
    const response = await this.dependencies.tuttidClient.listAgentTargets();
    if (signal?.aborted) {
      return this.snapshot;
    }
    const agentTargets = mapAgentTargetsToPresentations(response.targets, {
      resolveAgentIconUrl: this.dependencies.resolveAgentIconUrl
    }).map((target) =>
      this.dependencies.isAgentTargetProviderGated?.(target.provider) === true
        ? { ...target, enabled: false }
        : target
    );
    const nextSnapshot: AgentsSnapshot = {
      agentTargets,
      capturedAtUnixMs: this.dependencies.now?.() ?? Date.now(),
      providerTargets:
        mapAgentTargetPresentationsToProviderTargets(agentTargets)
    };
    this.snapshot = nextSnapshot;
    this.emit();
    return nextSnapshot;
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export function mapAgentTargetsToPresentations(
  targets: readonly AgentTarget[],
  options: { resolveAgentIconUrl?: (provider: string) => string } = {}
): readonly AgentTargetPresentation[] {
  return [...targets].sort(compareAgentTargetsForDisplay).map((target) => ({
    agentTargetId: target.id,
    createdAtUnixMs: target.createdAtUnixMs,
    enabled: target.enabled === true,
    iconKey: target.iconKey ?? null,
    iconUrl: resolveAgentTargetIconUrl(target, options.resolveAgentIconUrl),
    launchRefType: target.launchRef.type,
    name: target.name,
    provider: target.provider,
    sortOrder: target.sortOrder,
    source: target.source,
    updatedAtUnixMs: target.updatedAtUnixMs
  }));
}

export function mapAgentTargetPresentationsToProviderTargets(
  targets: readonly AgentTargetPresentation[]
): readonly AgentGUIProviderTarget[] {
  return targets.map((target) => {
    const provider = target.provider as AgentGUIProvider;
    const ref: AgentGUIProviderTargetRef = {
      kind: target.launchRefType,
      provider,
      targetId: target.agentTargetId
    };
    return {
      targetId: target.agentTargetId,
      agentTargetId: target.agentTargetId,
      provider,
      ref,
      label: target.name,
      iconUrl: target.iconUrl,
      disabled: target.enabled !== true
    };
  });
}

function resolveAgentTargetIconUrl(
  target: AgentTarget,
  resolveAgentIconUrl?: (provider: string) => string
): string {
  return resolveAgentIconUrl?.(target.provider) ?? "";
}

function compareAgentTargetsForDisplay(
  left: AgentTarget,
  right: AgentTarget
): number {
  return (
    left.sortOrder - right.sortOrder ||
    left.name.localeCompare(right.name) ||
    left.id.localeCompare(right.id)
  );
}
