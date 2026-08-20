import {
  Button,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@tutti-os/ui-system/components";

import type { ConnectorMarketI18nRuntime } from "../i18n/connectorMarketI18n.ts";
import { ConnectorIcon } from "../catalog/ConnectorIcon.tsx";

export interface ConnectorManagementDialogProps {
  canDisconnectAuthorization: boolean;
  canUninstall: boolean;
  description: string;
  displayName: string;
  iconUrl: string;
  i18n: ConnectorMarketI18nRuntime;
  onDisconnect: () => void;
  onRequestUninstall: () => void;
  onTry: () => void;
}

export function ConnectorManagementDialog({
  canDisconnectAuthorization,
  canUninstall,
  description,
  displayName,
  iconUrl,
  i18n,
  onDisconnect,
  onRequestUninstall,
  onTry
}: ConnectorManagementDialogProps) {
  return (
    <DialogContent className="sm:max-w-[500px]">
      <DialogHeader className="items-center gap-3 px-6 pt-4 text-center">
        <ConnectorIcon displayName={displayName} iconUrl={iconUrl} size="lg" />
        <DialogTitle>{displayName}</DialogTitle>
      </DialogHeader>

      <p className="m-0 px-6 text-center text-[13px] leading-6 text-[var(--text-secondary)]">
        {description}
      </p>

      <DialogFooter className="gap-2.5 pt-2 sm:justify-center">
        <Button
          disabled={!canUninstall}
          size="dialog"
          type="button"
          variant="destructive-secondary"
          onClick={onRequestUninstall}
        >
          {i18n.t("actionUninstall")}
        </Button>
        {canDisconnectAuthorization ? (
          <Button
            size="dialog"
            type="button"
            variant="secondary"
            onClick={onDisconnect}
          >
            {i18n.t("actionDisconnect")}
          </Button>
        ) : null}
        <Button size="dialog" type="button" onClick={onTry}>
          {i18n.t("actionTry")}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
