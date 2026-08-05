import {
  Button,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  StatusDot,
  Switch
} from "@tutti-os/ui-system/components";

import type { ConnectorMarketI18nRuntime } from "../../i18n/connectorMarketI18n.ts";
import type {
  ConnectorDetailFieldView,
  ConnectorPermissionView
} from "../../services/view/connectorMarketViewTypes.ts";
import { ConnectorIcon } from "../catalog/ConnectorIcon.tsx";
import { ConnectorDialogSection } from "./ConnectorDialogSection.tsx";
import { connectorDetailLabel } from "./connectorDetailLabel.ts";
import { ConnectorPermissionList } from "./ConnectorPermissionList.tsx";

export interface ConnectorManagementDialogProps {
  canAuthorize: boolean;
  connectorKey: string;
  details: ReadonlyArray<Readonly<ConnectorDetailFieldView>>;
  displayName: string;
  i18n: ConnectorMarketI18nRuntime;
  onAuthorize: () => void;
  onClose: () => void;
  onUninstall: () => void;
  onWorkspaceEnabledChange: (enabled: boolean) => void;
  permissions: ReadonlyArray<Readonly<ConnectorPermissionView>>;
  workspaceEnabled: boolean;
}

export function ConnectorManagementDialog({
  canAuthorize,
  connectorKey,
  details,
  displayName,
  i18n,
  onAuthorize,
  onClose,
  onUninstall,
  onWorkspaceEnabledChange,
  permissions,
  workspaceEnabled
}: ConnectorManagementDialogProps) {
  return (
    <DialogContent className="max-h-[min(720px,calc(100vh-32px))] overflow-y-auto sm:max-w-[520px]">
      <DialogHeader>
        <div className="flex items-center gap-3 pr-8">
          <ConnectorIcon
            connectorKey={connectorKey}
            displayName={displayName}
            size="lg"
          />
          <div className="min-w-0">
            <DialogTitle>
              {i18n.t("dialogManagementTitle", { name: displayName })}
            </DialogTitle>
            <DialogDescription>
              {i18n.t("dialogManagementDescription")}
            </DialogDescription>
            <div className="mt-1 flex items-center gap-1.5 text-[11px] text-[var(--state-success)]">
              <StatusDot size="xs" tone="green" />
              {i18n.t("connectedStatus")}
            </div>
          </div>
        </div>
      </DialogHeader>

      <dl className="grid grid-cols-2 overflow-hidden rounded-lg border border-[var(--border-1)]">
        {details.map((detail, index) => {
          const isLastRow = index >= details.length - 2;
          return (
            <div
              key={detail.id}
              className={`flex min-w-0 items-center justify-between gap-3 border-r border-[var(--border-1)] px-3 py-2.5 even:border-r-0 ${
                isLastRow ? "" : "border-b"
              }`}
            >
              <dt className="text-[11px] text-[var(--text-tertiary)]">
                {connectorDetailLabel(detail.id, i18n)}
              </dt>
              <dd className="m-0 truncate text-[11px] text-[var(--text-primary)]">
                {detail.value}
              </dd>
            </div>
          );
        })}
      </dl>

      <ConnectorDialogSection title={i18n.t("permissionsTitle")}>
        <ConnectorPermissionList i18n={i18n} permissions={permissions} />
      </ConnectorDialogSection>

      <div className="flex items-center justify-between gap-4 rounded-lg border border-[var(--border-1)] px-3 py-3">
        <div className="min-w-0">
          <div className="text-[12px] font-medium text-[var(--text-primary)]">
            {i18n.t("workspaceAccess")}
          </div>
          <div className="mt-0.5 text-[11px] leading-[1.4] text-[var(--text-secondary)]">
            {i18n.t("workspaceAccessDescription")}
          </div>
        </div>
        <Switch
          checked={workspaceEnabled}
          onCheckedChange={onWorkspaceEnabledChange}
        />
      </div>

      <DialogFooter className="sm:justify-between">
        <Button
          size="dialog"
          type="button"
          variant="destructive-secondary"
          onClick={onUninstall}
        >
          {i18n.t("actionUninstall")}
        </Button>
        <div className="flex items-center justify-end gap-2.5">
          <Button
            size="dialog"
            type="button"
            variant="secondary"
            onClick={onClose}
          >
            {i18n.t("close")}
          </Button>
          {canAuthorize ? (
            <Button size="dialog" type="button" onClick={onAuthorize}>
              {i18n.t("actionUpdateAuthorization")}
            </Button>
          ) : null}
        </div>
      </DialogFooter>
    </DialogContent>
  );
}
