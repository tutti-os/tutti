import type { TuttidEventStreamClient } from "@tutti-os/client-tuttid-ts";
import type {
  WorkspaceAgentComposerDefaultsInvalidatedEvent,
  WorkspaceAgentConnectorCatalogInvalidatedEvent,
  WorkspaceAgentModelCatalogInvalidatedEvent
} from "../workspaceAgentActivityService.interface.ts";
import type { WorkspaceAgentSessionEngineHost } from "./workspaceAgentSessionEngineHost.ts";
import {
  isFeatureEnabled,
  LAB_CONNECTORS_FLAG
} from "../../../../../../shared/featureFlags/catalog.ts";

export class WorkspaceAgentComposerOptionsInvalidationCoordinator {
  private readonly hosts: () => Iterable<WorkspaceAgentSessionEngineHost>;
  private readonly modelCatalogListeners = new Set<
    (event: WorkspaceAgentModelCatalogInvalidatedEvent) => void
  >();
  private readonly composerDefaultsListeners = new Set<
    (event: WorkspaceAgentComposerDefaultsInvalidatedEvent) => void
  >();
  private readonly connectorCatalogListeners = new Set<
    (event: WorkspaceAgentConnectorCatalogInvalidatedEvent) => void
  >();
  private connectorCatalogEventRevision = 0;
  private connectorMarketRevision = 0;
  private disposed = false;
  private connectorsVisible: boolean | null = null;

  constructor(hosts: () => Iterable<WorkspaceAgentSessionEngineHost>) {
    this.hosts = hosts;
  }

  onModelCatalogInvalidated(
    listener: (event: WorkspaceAgentModelCatalogInvalidatedEvent) => void
  ): () => void {
    if (this.disposed) return () => {};
    this.modelCatalogListeners.add(listener);
    return () => this.modelCatalogListeners.delete(listener);
  }

  onComposerDefaultsInvalidated(
    listener: (event: WorkspaceAgentComposerDefaultsInvalidatedEvent) => void
  ): () => void {
    if (this.disposed) return () => {};
    this.composerDefaultsListeners.add(listener);
    return () => this.composerDefaultsListeners.delete(listener);
  }

  onConnectorCatalogInvalidated(
    listener: (event: WorkspaceAgentConnectorCatalogInvalidatedEvent) => void
  ): () => void {
    if (this.disposed) return () => {};
    this.connectorCatalogListeners.add(listener);
    return () => this.connectorCatalogListeners.delete(listener);
  }

  subscribe(eventStreamClient: TuttidEventStreamClient): Array<() => void> {
    return [
      eventStreamClient.subscribe("agent.model.catalog.invalidated", (event) =>
        this.handleModelCatalogInvalidated({
          providers: [...event.payload.providers],
          occurredAtUnixMs: event.payload.occurredAtUnixMs
        })
      ),
      eventStreamClient.subscribe(
        "preferences.agent.composer.defaults.changed",
        (event) =>
          this.handleComposerDefaultsInvalidated(event.payload.agentTargetId)
      ),
      eventStreamClient.subscribe("connector.market.changed", (event) =>
        this.invalidateConnectorCatalog({
          ...(event.payload.connectorKey
            ? { connectorKey: event.payload.connectorKey }
            : {}),
          revision: event.payload.revision
        })
      ),
      eventStreamClient.subscribe("preferences.desktop.updated", (event) =>
        this.handleDesktopPreferencesUpdated(
          event.payload.preferences.featureFlags
        )
      )
    ];
  }

  dispose(): void {
    this.disposed = true;
    this.modelCatalogListeners.clear();
    this.composerDefaultsListeners.clear();
    this.connectorCatalogListeners.clear();
  }

  private handleModelCatalogInvalidated(
    event: WorkspaceAgentModelCatalogInvalidatedEvent
  ): void {
    if (this.disposed) return;
    for (const host of this.hosts()) {
      host.engine.dispatch({
        providers: event.providers,
        sections: ["core"],
        type: "composerOptions/invalidated"
      });
    }
    for (const listener of this.modelCatalogListeners) {
      listener({
        providers: [...event.providers],
        occurredAtUnixMs: event.occurredAtUnixMs
      });
    }
  }

  private handleComposerDefaultsInvalidated(agentTargetId: string): void {
    if (this.disposed) return;
    const normalizedAgentTargetId = agentTargetId.trim();
    if (!normalizedAgentTargetId) return;
    for (const host of this.hosts()) {
      host.engine.dispatch({
        sections: ["core"],
        targetKeys: [normalizedAgentTargetId],
        type: "composerOptions/invalidated"
      });
    }
    for (const listener of this.composerDefaultsListeners) {
      listener({ agentTargetId: normalizedAgentTargetId });
    }
  }

  invalidateConnectorCatalog(
    event: WorkspaceAgentConnectorCatalogInvalidatedEvent
  ): void {
    if (
      this.disposed ||
      !Number.isSafeInteger(event.revision) ||
      event.revision <= this.connectorMarketRevision
    ) {
      return;
    }
    this.connectorMarketRevision = event.revision;
    this.notifyConnectorCatalogInvalidated(event.connectorKey, event.revision);
  }

  private notifyConnectorCatalogInvalidated(
    connectorKey?: string,
    requestedRevision?: number
  ): void {
    const revision = Math.max(
      this.connectorCatalogEventRevision + 1,
      requestedRevision ?? 0
    );
    this.connectorCatalogEventRevision = revision;
    for (const host of this.hosts()) {
      host.engine.dispatch({
        sections: ["connectors"],
        type: "composerOptions/invalidated"
      });
    }
    for (const listener of this.connectorCatalogListeners) {
      listener({
        ...(connectorKey ? { connectorKey } : {}),
        revision
      });
    }
  }

  private handleDesktopPreferencesUpdated(
    featureFlags: Readonly<Record<string, boolean>>
  ): void {
    if (this.disposed) return;
    const connectorsVisible = isFeatureEnabled(
      featureFlags,
      LAB_CONNECTORS_FLAG
    );
    if (connectorsVisible === this.connectorsVisible) return;
    this.connectorsVisible = connectorsVisible;
    this.notifyConnectorCatalogInvalidated();
  }
}
