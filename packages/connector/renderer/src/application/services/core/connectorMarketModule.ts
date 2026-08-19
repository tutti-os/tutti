import {
  createDecorator,
  type IInstantiationService
} from "@tutti-os/infra/di";

import type { ConnectorMarketServiceDependencies } from "../connectorMarketService.interface.ts";
import type { ConnectorMarketScope } from "../ui-state/connectorMarketUiStateService.interface.ts";
import type { ConnectorMarketLifecycle } from "./connectorMarketLifecycle.ts";
import type { IConnectorMarketRoot } from "./connectorMarketRoot.interface.ts";
import { ConnectorMarketRuntime } from "./connectorMarketRuntime.ts";

export interface ConnectorMarketModuleDependencies {
  market: ConnectorMarketServiceDependencies;
  scope: ConnectorMarketScope;
}

export interface IConnectorMarketModule {
  readonly _serviceBrand: undefined;
  readonly lifecycle: ConnectorMarketLifecycle;
  readonly root: IConnectorMarketRoot;

  activate(parentInstantiationService: IInstantiationService): Promise<void>;
  dispose(): void;
}

export const IConnectorMarketModule = createDecorator<IConnectorMarketModule>(
  "connector-market-module"
);

export class ConnectorMarketModule implements IConnectorMarketModule {
  declare readonly _serviceBrand: undefined;

  private runtime: ConnectorMarketRuntime | null = null;
  private activationPromise: Promise<void> | null = null;
  private disposed = false;

  constructor(
    private readonly dependencies: ConnectorMarketModuleDependencies
  ) {}

  get lifecycle(): ConnectorMarketLifecycle {
    return this.requireRuntime().lifecycle;
  }

  get root(): IConnectorMarketRoot {
    const runtime = this.requireRuntime();
    if (runtime.lifecycle.phase !== "ready") {
      throw new Error("Connector market module is not ready");
    }
    return runtime.root;
  }

  activate(parentInstantiationService: IInstantiationService): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new Error("Connector market module is disposed"));
    }
    if (!this.activationPromise) {
      this.runtime = new ConnectorMarketRuntime({
        marketDependencies: this.dependencies.market,
        parentInstantiationService,
        scope: this.dependencies.scope
      });
      this.activationPromise = this.runtime.start();
    }
    return this.activationPromise;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.runtime?.dispose();
  }

  private requireRuntime(): ConnectorMarketRuntime {
    if (!this.runtime) {
      throw new Error("Connector market module has not been activated");
    }
    return this.runtime;
  }
}
