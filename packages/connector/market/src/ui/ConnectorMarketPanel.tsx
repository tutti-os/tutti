import { cn } from "@tutti-os/ui-system/utils";

import type { ConnectorMarketI18nRuntime } from "../i18n/connectorMarketI18n.ts";
import type { IConnectorMarketRoot } from "../services/core/connectorMarketRoot.interface.ts";
import { ConnectorMarketRootProvider } from "./ConnectorMarketServicesContext.tsx";
import { ConnectorCatalog } from "./catalog/ConnectorCatalog.tsx";
import { ConnectorMarketToolbar } from "./toolbar/ConnectorMarketToolbar.tsx";

export interface ConnectorMarketPanelProps {
  className?: string;
  i18n: ConnectorMarketI18nRuntime;
  onError?: (message: string) => void;
  onTryConnector?: (connectorKey: string) => void;
  root: IConnectorMarketRoot;
}

export function ConnectorMarketPanel({
  className,
  i18n,
  onError,
  onTryConnector,
  root
}: ConnectorMarketPanelProps) {
  return (
    <ConnectorMarketRootProvider
      i18n={i18n}
      onError={onError}
      onTryConnector={onTryConnector}
      root={root}
    >
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
      </section>
    </ConnectorMarketRootProvider>
  );
}
