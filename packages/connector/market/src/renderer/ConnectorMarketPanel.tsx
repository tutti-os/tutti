import { useMemo } from "react";
import { cn } from "@tutti-os/ui-system/utils";

import type { ConnectorMarketI18nRuntime } from "../i18n/connectorMarketI18n.ts";
import type { IConnectorMarketRoot } from "../services/core/connectorMarketRoot.interface.ts";
import { ConnectorMarketServicesProvider } from "./ConnectorMarketServicesContext.tsx";
import { ConnectorCatalog } from "./catalog/ConnectorCatalog.tsx";
import { ConnectorMarketDialogs } from "./dialogs/ConnectorMarketDialogs.tsx";
import { ConnectorMarketToolbar } from "./toolbar/ConnectorMarketToolbar.tsx";

export interface ConnectorMarketPanelProps {
  className?: string;
  i18n: ConnectorMarketI18nRuntime;
  root: IConnectorMarketRoot;
}

export function ConnectorMarketPanel({
  className,
  i18n,
  root
}: ConnectorMarketPanelProps) {
  const services = useMemo(
    () => ({
      i18n,
      market: root.market,
      uiState: root.uiState,
      view: root.view
    }),
    [i18n, root]
  );

  return (
    <ConnectorMarketServicesProvider services={services}>
      <section
        className={cn(
          "flex min-h-0 flex-1 flex-col gap-5 pb-[22px]",
          className
        )}
        data-testid="connector-market-panel"
      >
        <header className="shrink-0">
          <h2 className="m-0 text-[18px] font-semibold leading-[1.35] text-[var(--text-primary)]">
            {i18n.t("title")}
          </h2>
          <p className="mb-0 mt-1 text-[12px] leading-[1.5] text-[var(--text-secondary)]">
            {i18n.t("description")}
          </p>
        </header>
        <ConnectorMarketToolbar />
        <ConnectorCatalog />
        <ConnectorMarketDialogs />
      </section>
    </ConnectorMarketServicesProvider>
  );
}
