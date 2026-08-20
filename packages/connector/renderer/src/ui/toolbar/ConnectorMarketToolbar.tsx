import { Button, Input } from "@tutti-os/ui-system/components";
import { RefreshIcon, SearchIcon } from "@tutti-os/ui-system/icons";
import { useSnapshot } from "valtio";

import { useConnectorMarketServices } from "../ConnectorMarketServicesContext.tsx";

export function ConnectorMarketToolbar() {
  const { i18n, market, uiState, view } = useConnectorMarketServices();
  const ui = useSnapshot(uiState.dataStore);
  const marketView = useSnapshot(view.dataStore);

  return (
    <div className="flex items-center gap-2">
      <label className="relative min-w-0 flex-1">
        <span className="sr-only">{i18n.t("searchLabel")}</span>
        <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-[var(--text-tertiary)]" />
        <Input
          className="pl-8"
          placeholder={i18n.t("searchPlaceholder")}
          value={ui.query}
          onChange={(event) => uiState.setQuery(event.currentTarget.value)}
        />
      </label>
      <Button
        aria-label={i18n.t("actionRefresh")}
        disabled={marketView.refreshing}
        size="sm"
        type="button"
        variant="secondary"
        onClick={() => void market.refreshCatalog().catch(() => undefined)}
      >
        <RefreshIcon
          className={marketView.refreshing ? "animate-spin" : undefined}
        />
        {i18n.t("actionRefresh")}
      </Button>
    </div>
  );
}
