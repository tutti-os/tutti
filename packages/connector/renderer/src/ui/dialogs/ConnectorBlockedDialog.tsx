import {
  Button,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@tutti-os/ui-system/components";
import { WarningLinedIcon } from "@tutti-os/ui-system/icons";

import type { ConnectorMarketI18nRuntime } from "../i18n/connectorMarketI18n.ts";
import { ConnectorIcon } from "../catalog/ConnectorIcon.tsx";

export interface ConnectorBlockedDialogProps {
  displayName: string;
  iconUrl: string;
  i18n: ConnectorMarketI18nRuntime;
  onClose: () => void;
  reason: string;
}

export function ConnectorBlockedDialog({
  displayName,
  iconUrl,
  i18n,
  onClose,
  reason
}: ConnectorBlockedDialogProps) {
  return (
    <DialogContent className="sm:max-w-[420px]">
      <DialogHeader>
        <div className="flex items-center gap-3 pr-8">
          <ConnectorIcon
            displayName={displayName}
            iconUrl={iconUrl}
            size="lg"
          />
          <WarningLinedIcon className="size-5 text-[var(--state-warning)]" />
        </div>
        <DialogTitle>{i18n.t("blockedTitle")}</DialogTitle>
        <DialogDescription>{i18n.t("blockedDescription")}</DialogDescription>
      </DialogHeader>
      <div className="rounded-lg bg-[var(--transparency-block)] px-3 py-2 text-[11px] text-[var(--text-secondary)]">
        {reason}
      </div>
      <DialogFooter>
        <Button size="dialog" type="button" onClick={onClose}>
          {i18n.t("close")}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
