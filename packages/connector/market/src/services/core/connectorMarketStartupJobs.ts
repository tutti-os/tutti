import { makeBarrierByPromise } from "@tutti-os/infra/async";
import { AbstractJob } from "@tutti-os/infra/launch";

import {
  IConnectorMarketService,
  type IConnectorMarketService as ConnectorMarketService
} from "../connectorMarketService.interface.ts";
import {
  IConnectorMarketUiStateService,
  type ConnectorMarketScope,
  type IConnectorMarketUiStateService as ConnectorMarketUiStateService
} from "../ui-state/connectorMarketUiStateService.interface.ts";
import {
  IConnectorMarketViewService,
  type IConnectorMarketViewService as ConnectorMarketViewService
} from "../view/connectorMarketViewService.interface.ts";
import type { ConnectorMarketLifecyclePhase } from "./connectorMarketLifecycle.ts";

export class ConnectorMarketServiceStartupJob extends AbstractJob<ConnectorMarketLifecyclePhase> {
  protected _name = "connector-market-service-startup";

  constructor(private readonly market: ConnectorMarketService) {
    super();
  }

  protected _executePhase(phase: ConnectorMarketLifecyclePhase): void {
    if (phase === "starting") {
      this.market.start();
    }
    if (phase === "synchronizing") {
      this._setBarrier(
        phase,
        makeBarrierByPromise(
          this.market.ensureLoaded().catch(() => {
            // Connector Market is optional at desktop startup. The service
            // already records the load error for its own error state; do not
            // let an unavailable catalog reject the global lifecycle barrier.
          })
        )
      );
    }
  }
}

export class ConnectorMarketUiStateServiceStartupJob extends AbstractJob<ConnectorMarketLifecyclePhase> {
  protected _name = "connector-market-ui-state-service-startup";

  constructor(
    private readonly scope: ConnectorMarketScope,
    private readonly uiState: ConnectorMarketUiStateService
  ) {
    super();
  }

  protected _executePhase(phase: ConnectorMarketLifecyclePhase): void {
    if (phase === "starting") {
      this.uiState.start(this.scope);
    }
  }
}

export class ConnectorMarketViewServiceStartupJob extends AbstractJob<ConnectorMarketLifecyclePhase> {
  protected _name = "connector-market-view-service-startup";

  constructor(private readonly view: ConnectorMarketViewService) {
    super();
  }

  protected _executePhase(phase: ConnectorMarketLifecyclePhase): void {
    if (phase === "materializing") {
      this.view.start();
    }
  }
}

IConnectorMarketService(ConnectorMarketServiceStartupJob, undefined, 0);
IConnectorMarketUiStateService(
  ConnectorMarketUiStateServiceStartupJob,
  undefined,
  1
);
IConnectorMarketViewService(ConnectorMarketViewServiceStartupJob, undefined, 0);
