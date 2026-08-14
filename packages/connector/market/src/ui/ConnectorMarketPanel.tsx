import { cn } from "@tutti-os/ui-system/utils";

import type { AuthorizationViewRenderer } from "../authorization/AuthorizationViewRenderer.tsx";
import type { ConnectorMarketI18nRuntime } from "../i18n/connectorMarketI18n.ts";
import type { IConnectorMarketRoot } from "../services/core/connectorMarketRoot.interface.ts";
import { ConnectorMarketRootProvider } from "./ConnectorMarketServicesContext.tsx";
import { ConnectorCatalog } from "./catalog/ConnectorCatalog.tsx";
import { ConnectorMarketToolbar } from "./toolbar/ConnectorMarketToolbar.tsx";

export interface ConnectorMarketPanelProps {
  authorizationRenderer?: AuthorizationViewRenderer;
  className?: string;
  i18n: ConnectorMarketI18nRuntime;
  locale?: string;
  onError?: (message: string) => void;
  onTryConnector?: (connectorKey: string) => void;
  root: IConnectorMarketRoot;
}

export function ConnectorMarketPanel({
  authorizationRenderer,
  className,
  i18n,
  locale,
  onError,
  onTryConnector,
  root
}: ConnectorMarketPanelProps) {
  return (
    <ConnectorMarketRootProvider
      authorizationRenderer={authorizationRenderer}
      i18n={i18n}
      locale={locale}
      onError={onError}
      onTryConnector={onTryConnector}
      root={root}
    >
      <section
        className={cn(
          "flex min-h-0 flex-1 flex-col gap-5 pb-5",
          className
        )}
        data-testid="connector-market-panel"
      >
        <header className="shrink-0">
          <p className="mb-0 mt-1 text-[12px] leading-[1.5] text-[var(--text-secondary)]">
            {i18n.t("description")}
          </p>
        </header>
        <div className="sticky top-0 z-10 bg-[var(--background-panel)]"><ConnectorMarketToolbar /></div>
        <ConnectorCatalog />
      </section>
    </ConnectorMarketRootProvider>
  );
}
