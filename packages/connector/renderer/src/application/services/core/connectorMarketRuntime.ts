import {
  ServiceRegistry,
  SyncDescriptor,
  type IInstantiationService
} from "@tutti-os/infra/di";
import { JobScheduler } from "@tutti-os/infra/launch";

import { ConnectorMarketService } from "../connectorMarketService.ts";
import {
  IConnectorMarketService,
  type ConnectorMarketServiceDependencies
} from "../connectorMarketService.interface.ts";
import { ConnectorMarketUiStateService } from "../ui-state/connectorMarketUiStateService.ts";
import {
  IConnectorMarketUiStateService,
  type ConnectorMarketScope
} from "../ui-state/connectorMarketUiStateService.interface.ts";
import { ConnectorMarketViewService } from "../view/connectorMarketViewService.ts";
import { IConnectorMarketViewService } from "../view/connectorMarketViewService.interface.ts";
import {
  ConnectorMarketLifecycle,
  type ConnectorMarketLifecyclePhase
} from "./connectorMarketLifecycle.ts";
import { IConnectorMarketRoot } from "./connectorMarketRoot.interface.ts";
import {
  ConnectorMarketRoot,
  type ConnectorMarketRoot as ConnectorMarketRootService
} from "./connectorMarketRoot.ts";
import {
  ConnectorMarketServiceStartupJob,
  ConnectorMarketUiStateServiceStartupJob,
  ConnectorMarketViewServiceStartupJob
} from "./connectorMarketStartupJobs.ts";

export interface CreateConnectorMarketRuntimeInput {
  marketDependencies: ConnectorMarketServiceDependencies;
  parentInstantiationService: IInstantiationService;
  scope: ConnectorMarketScope;
}

const startupPhases: readonly ConnectorMarketLifecyclePhase[] = [
  "starting",
  "synchronizing",
  "materializing",
  "ready"
];

export class ConnectorMarketRuntime {
  readonly instantiationService: IInstantiationService;
  readonly lifecycle = new ConnectorMarketLifecycle();
  readonly root: ConnectorMarketRootService;

  private readonly scheduler: JobScheduler<ConnectorMarketLifecyclePhase>;
  private startupPromise: Promise<void> | null = null;
  private disposed = false;

  constructor(input: CreateConnectorMarketRuntimeInput) {
    const registry = new ServiceRegistry({ checkDuplicate: true });
    // Disposal follows registration order. View goes first so its subscriptions
    // are detached before UiState and the authoritative Market service stop.
    registry.register(
      IConnectorMarketRoot,
      new SyncDescriptor(ConnectorMarketRoot)
    );
    registry.register(
      IConnectorMarketViewService,
      new SyncDescriptor(ConnectorMarketViewService)
    );
    registry.register(
      IConnectorMarketUiStateService,
      new SyncDescriptor(ConnectorMarketUiStateService)
    );
    registry.register(
      IConnectorMarketService,
      new SyncDescriptor(ConnectorMarketService, [input.marketDependencies])
    );

    this.instantiationService = input.parentInstantiationService.createChild(
      registry.makeCollection()
    );
    this.root = this.instantiationService.invokeFunction((accessor) =>
      accessor.get(IConnectorMarketRoot)
    );
    this.scheduler = new JobScheduler<ConnectorMarketLifecyclePhase>(
      "created",
      this.instantiationService
    );
    this.scheduler.registerJob("starting", ConnectorMarketServiceStartupJob);
    this.scheduler.registerJob(
      "starting",
      ConnectorMarketUiStateServiceStartupJob,
      input.scope
    );
    this.scheduler.registerJob(
      "materializing",
      ConnectorMarketViewServiceStartupJob
    );
  }

  start(): Promise<void> {
    if (!this.startupPromise) {
      this.startupPromise = this.runPhases(0).catch((error) => {
        if (!this.disposed) {
          this.lifecycle.fail(error);
          this.instantiationService.dispose();
        }
        throw error;
      });
    }
    return this.startupPromise;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (
      this.lifecycle.phase !== "stopping" &&
      this.lifecycle.phase !== "disposed"
    ) {
      this.lifecycle.advance("stopping");
    }
    this.instantiationService.dispose();
    if (this.lifecycle.phase !== "disposed") {
      this.lifecycle.advance("disposed");
    }
  }

  private async runPhases(index: number): Promise<void> {
    for (
      let nextIndex = index;
      nextIndex < startupPhases.length;
      nextIndex += 1
    ) {
      if (this.disposed) {
        return;
      }
      const phase = startupPhases[nextIndex];
      if (!phase) {
        continue;
      }
      this.lifecycle.advance(phase);
      if (this.scheduler.prepare(phase)) {
        await this.scheduler.wait(phase);
      } else {
        this.scheduler.advanceToPhase(phase);
      }
    }
  }
}
