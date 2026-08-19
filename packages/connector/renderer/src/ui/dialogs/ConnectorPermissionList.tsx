import { GuideIcon } from "@tutti-os/ui-system/icons";

import type { ConnectorMarketI18nRuntime } from "../i18n/connectorMarketI18n.ts";
import type { ConnectorPermissionView } from "../../application/services/view/connectorMarketViewTypes.ts";

export interface ConnectorPermissionListProps {
  i18n: ConnectorMarketI18nRuntime;
  permissions: ReadonlyArray<Readonly<ConnectorPermissionView>>;
}

export function ConnectorPermissionList({
  i18n,
  permissions
}: ConnectorPermissionListProps) {
  if (permissions.length === 0) {
    return (
      <div className="rounded-lg border border-[var(--border-1)] px-3 py-3 text-[11px] text-[var(--text-secondary)]">
        {i18n.t("noPermissions")}
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-lg border border-[var(--border-1)]">
      {permissions.map((permission) => (
        <div
          key={permission.id}
          className="flex items-center gap-3 border-b border-[var(--border-1)] px-3 py-2.5 last:border-b-0"
        >
          <GuideIcon className="size-4 shrink-0 text-[var(--state-success)]" />
          <span className="min-w-0 break-all text-[12px] text-[var(--text-primary)]">
            {permission.name}
          </span>
        </div>
      ))}
    </div>
  );
}
