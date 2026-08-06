import {
  Button,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@tutti-os/ui-system/components";

import type { ConnectorMarketI18nRuntime } from "../../i18n/connectorMarketI18n.ts";
import { ConnectorIcon } from "../catalog/ConnectorIcon.tsx";

export function ConnectorInstallationDialog({
  displayName,
  iconUrl,
  i18n,
  onClose,
  onInstall
}: {
  displayName: string;
  iconUrl: string;
  i18n: ConnectorMarketI18nRuntime;
  onClose: () => void;
  onInstall: () => void;
}) {
  return (
    <DialogContent className="max-h-[min(720px,calc(100vh-32px))] overflow-y-auto sm:max-w-[520px]">
      <DialogHeader>
        <div className="flex items-center gap-3 pr-8">
          <ConnectorIcon
            displayName={displayName}
            iconUrl={iconUrl}
            size="lg"
          />
          <div>
            <DialogTitle>
              {i18n.t("dialogInstallationTitle", { name: displayName })}
            </DialogTitle>
            <DialogDescription>
              {i18n.t("dialogInstallationDescription")}
            </DialogDescription>
          </div>
        </div>
      </DialogHeader>
      <DialogFooter>
        <Button
          size="dialog"
          type="button"
          variant="secondary"
          onClick={onClose}
        >
          {i18n.t("cancel")}
        </Button>
        <Button size="dialog" type="button" onClick={onInstall}>
          {i18n.t("actionInstall")}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
