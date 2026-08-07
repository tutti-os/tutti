import type { TuttidEventStreamClient } from "@tutti-os/client-tuttid-ts";
import type {
  WorkspaceAgentComposerDefaultsInvalidatedEvent,
  WorkspaceAgentConnectorCatalogInvalidatedEvent,
  WorkspaceAgentModelCatalogInvalidatedEvent
} from "../workspaceAgentActivityService.interface.ts";
import type { WorkspaceAgentSessionEngineHost } from "./workspaceAgentSessionEngineHost.ts";

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
  private connectorCatalogRevision = 0;
  private disposed = false;

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
      event.revision <= this.connectorCatalogRevision
    ) {
      return;
    }
    this.connectorCatalogRevision = event.revision;
    for (const host of this.hosts()) {
      host.engine.dispatch({ type: "composerOptions/invalidated" });
    }
    for (const listener of this.connectorCatalogListeners) {
      listener({
        ...(event.connectorKey ? { connectorKey: event.connectorKey } : {}),
        revision: event.revision
      });
    }
  }
}
