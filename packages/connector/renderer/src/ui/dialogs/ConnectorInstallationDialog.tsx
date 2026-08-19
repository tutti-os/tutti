import {
  Button,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Spinner
} from "@tutti-os/ui-system/components";

import type { ConnectorMarketI18nRuntime } from "../i18n/connectorMarketI18n.ts";

export function ConnectorInstallationDialog({
  description,
  displayName,
  i18n,
  installing,
  updating,
  onClose,
  onInstall
}: {
  description: string;
  displayName: string;
  i18n: ConnectorMarketI18nRuntime;
  installing: boolean;
  updating: boolean;
  onClose: () => void;
  onInstall: () => void;
}) {
  return (
    <DialogContent
      aria-busy={installing}
      className="max-h-[min(720px,calc(100vh-32px))] overflow-y-auto sm:max-w-[500px]"
      showCloseButton={false}
    >
      <DialogHeader className="gap-3 px-6 pt-4">
        <DialogTitle>
          {i18n.t(updating ? "dialogUpdateTitle" : "dialogInstallationTitle", {
            name: displayName
          })}
        </DialogTitle>
      </DialogHeader>

      <DialogDescription className="px-6 text-[13px] leading-6">
        {updating
          ? i18n.t("dialogUpdateDescription")
          : description || i18n.t("dialogInstallationDescription")}
      </DialogDescription>

      <DialogFooter>
        <Button
          disabled={installing}
          size="dialog"
          type="button"
          variant="secondary"
          onClick={onClose}
        >
          {i18n.t("cancel")}
        </Button>
        <Button
          disabled={installing}
          size="dialog"
          type="button"
          onClick={onInstall}
        >
          {installing ? <Spinner size={14} /> : null}
          {installing
            ? i18n.t(updating ? "actionUpdating" : "actionInstalling")
            : i18n.t(updating ? "actionUpdate" : "actionInstall")}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
