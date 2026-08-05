import {
  Button,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Spinner
} from "@tutti-os/ui-system/components";
import {
  LinkIcon,
  LockGridHorizontalLinedIcon,
  UserLinedIcon
} from "@tutti-os/ui-system/icons";

import type { ConnectorMarketI18nRuntime } from "../../i18n/connectorMarketI18n.ts";
import type { ConnectorPermissionView } from "../../services/view/connectorMarketViewTypes.ts";
import { ConnectorIcon } from "../catalog/ConnectorIcon.tsx";
import { ConnectorDialogInfoRow } from "./ConnectorDialogInfoRow.tsx";
import { ConnectorDialogSection } from "./ConnectorDialogSection.tsx";
import { ConnectorPermissionList } from "./ConnectorPermissionList.tsx";

export interface ConnectorAuthorizationDialogProps {
  connectorKey: string;
  displayName: string;
  i18n: ConnectorMarketI18nRuntime;
  onAuthorize: () => void;
  onClose: () => void;
  pending: boolean;
  permissions: ReadonlyArray<Readonly<ConnectorPermissionView>>;
}

export function ConnectorAuthorizationDialog({
  connectorKey,
  displayName,
  i18n,
  onAuthorize,
  onClose,
  pending,
  permissions
}: ConnectorAuthorizationDialogProps) {
  return (
    <DialogContent className="max-h-[min(720px,calc(100vh-32px))] overflow-y-auto sm:max-w-[520px]">
      <DialogHeader className="items-center px-5 pt-4 text-center">
        <div className="mb-1 flex items-center gap-3">
          <ConnectorIcon
            connectorKey={connectorKey}
            displayName={displayName}
            size="lg"
          />
          <LinkIcon className="size-4 text-[var(--text-tertiary)]" />
          <span className="flex size-12 items-center justify-center rounded-xl bg-[var(--accent-bg)] text-[18px] font-bold text-[var(--accent)]">
            T
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
          icon={
            <ConnectorIcon
              connectorKey={connectorKey}
              displayName={displayName}
            />
          }
          title={i18n.t("accountSelectionTitle", { name: displayName })}
        />
      </div>

      <ConnectorDialogSection title={i18n.t("permissionsTitle")}>
        <ConnectorPermissionList i18n={i18n} permissions={permissions} />
      </ConnectorDialogSection>

      <ConnectorDialogSection title={i18n.t("accessScopeTitle")}>
        <div className="overflow-hidden rounded-lg border border-[var(--border-1)]">
          <ConnectorDialogInfoRow
            description={i18n.t("accountResourcesDescription", {
              name: displayName
            })}
            icon={<UserLinedIcon className="size-4" />}
            title={i18n.t("accountResourcesTitle")}
          />
          <ConnectorDialogInfoRow
            description={i18n.t("organizationResourcesDescription")}
            icon={<LockGridHorizontalLinedIcon className="size-4" />}
            title={i18n.t("organizationResourcesTitle")}
          />
        </div>
      </ConnectorDialogSection>

      <div className="flex items-start gap-2 px-1 text-[11px] leading-[1.45] text-[var(--text-tertiary)]">
        <LockGridHorizontalLinedIcon className="mt-0.5 size-4 shrink-0" />
        <span>{i18n.t("permissionNotice")}</span>
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
          disabled={pending}
          size="dialog"
          type="button"
          onClick={onAuthorize}
        >
          {pending ? <Spinner size={14} /> : null}
          {pending
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
