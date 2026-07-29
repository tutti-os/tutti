import { AnalyticsDebugFloatingEntry as SharedAnalyticsDebugFloatingEntry } from "@tutti-os/analytics-debug/react";
import { useService } from "@tutti-os/infra/di";
import { useTranslation } from "@renderer/i18n";

import { IAnalyticsDebugEventService } from "../services/analyticsDebugEventService.interface";

export function AnalyticsDebugFloatingEntry() {
  const { t } = useTranslation();
  const store = useService(IAnalyticsDebugEventService);

  return (
    <SharedAnalyticsDebugFloatingEntry
      labels={{
        clear: t("workspace.analyticsDebug.clear"),
        clientTimestamp: (value) =>
          t("workspace.analyticsDebug.clientTimestamp", { value }),
        close: t("workspace.analyticsDebug.close"),
        count: (count) => t("workspace.analyticsDebug.count", { count }),
        empty: t("workspace.analyticsDebug.empty"),
        open: t("workspace.analyticsDebug.open"),
        title: t("workspace.analyticsDebug.title")
      }}
      store={store}
    />
  );
}
