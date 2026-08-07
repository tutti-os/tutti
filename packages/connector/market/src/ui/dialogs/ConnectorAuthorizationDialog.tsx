import {
  Button,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Spinner
} from "@tutti-os/ui-system/components";
import { LinkIcon, TuttiMark } from "@tutti-os/ui-system/icons";

import type { ConnectorMarketI18nRuntime } from "../../i18n/connectorMarketI18n.ts";
import { ConnectorIcon } from "../catalog/ConnectorIcon.tsx";
import { ConnectorDialogInfoRow } from "./ConnectorDialogInfoRow.tsx";

export interface ConnectorAuthorizationDialogProps {
  authorizing: boolean;
  displayName: string;
  iconUrl: string;
  i18n: ConnectorMarketI18nRuntime;
  onAuthorize: () => Promise<void>;
  onClose: () => void;
  pending: boolean;
}

export function ConnectorAuthorizationDialog({
  authorizing,
  displayName,
  iconUrl,
  i18n,
  onAuthorize,
  onClose,
  pending
}: ConnectorAuthorizationDialogProps) {
  return (
    <DialogContent className="max-h-[min(720px,calc(100vh-32px))] overflow-y-auto sm:max-w-[520px]">
      <DialogHeader className="items-center px-5 pt-4 text-center">
        <div className="mb-1 flex items-center gap-3">
          <ConnectorIcon
            displayName={displayName}
            iconUrl={iconUrl}
            size="lg"
          />
          <LinkIcon className="size-4 text-[var(--text-tertiary)]" />
          <span className="flex size-12 items-center justify-center rounded-xl bg-[var(--accent-bg)] text-[var(--accent)]">
            <TuttiMark size={28} />
          </span>
        </div>
        <DialogTitle>
          {i18n.t("dialogAuthorizationTitle", { name: displayName })}
        </DialogTitle>
        <DialogDescription>
          {pending
            ? i18n.t("dialogAuthorizationPending")
            : i18n.t("dialogAuthorizationDescription", {
                name: displayName
              })}
        </DialogDescription>
      </DialogHeader>

      <div className="overflow-hidden rounded-lg border border-[var(--border-1)]">
        <ConnectorDialogInfoRow
          description={i18n.t("accountSelectionDescription")}
          icon={<ConnectorIcon displayName={displayName} iconUrl={iconUrl} />}
          title={i18n.t("accountSelectionTitle", { name: displayName })}
        />
      </div>

      <DialogFooter>
        <Button
          size="dialog"
          type="button"
          variant="secondary"
          onClick={onClose}
        >
          {i18n.t("cancel")}
        </Button>
        <Button
          disabled={authorizing}
          size="dialog"
          type="button"
          onClick={() => void onAuthorize()}
        >
          {authorizing && !pending ? <Spinner size={14} /> : null}
          {authorizing && pending
            ? i18n.t("actionWaitingAuthorization")
            : pending
              ? i18n.t("actionContinueAuthorization")
              : i18n.t("actionAuthorize")}
        </Button>
      </DialogFooter>
      <p className="m-0 text-center text-[11px] text-[var(--text-tertiary)]">
        {i18n.t("exactAccessNotice")}
      </p>
    </DialogContent>
  );
}
