import {
  Button,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Spinner
} from "@tutti-os/ui-system/components";
import {
  LinkIcon,
  LockGridHorizontalLinedIcon,
  TuttiMark,
  UserLinedIcon
} from "@tutti-os/ui-system/icons";
import { useState } from "react";

import type { ConnectorMarketI18nRuntime } from "../../i18n/connectorMarketI18n.ts";
import type { ConnectorPermissionView } from "../../services/view/connectorMarketViewTypes.ts";
import { ConnectorIcon } from "../catalog/ConnectorIcon.tsx";
import { ConnectorDialogInfoRow } from "./ConnectorDialogInfoRow.tsx";
import { ConnectorDialogSection } from "./ConnectorDialogSection.tsx";
import { ConnectorPermissionList } from "./ConnectorPermissionList.tsx";

export interface ConnectorAuthorizationDialogProps {
  authorizationKind: string;
  authorizing: boolean;
  displayName: string;
  iconUrl: string;
  i18n: ConnectorMarketI18nRuntime;
  onAuthorize: (secret?: string) => Promise<void>;
  onClose: () => void;
  pending: boolean;
  permissions: readonly ConnectorPermissionView[];
}

export function ConnectorAuthorizationDialog({
  authorizationKind,
  authorizing,
  displayName,
  iconUrl,
  i18n,
  onAuthorize,
  onClose,
  pending,
  permissions
}: ConnectorAuthorizationDialogProps) {
  const [secret, setSecret] = useState("");
  const usesSecret = authorizationKind === "api_key";
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
            : i18n.t("dialogAuthorizationDescription", { name: displayName })}
        </DialogDescription>
      </DialogHeader>

      <div className="overflow-hidden rounded-lg border border-[var(--border-1)]">
        <ConnectorDialogInfoRow
          description={i18n.t("accountSelectionDescription")}
          icon={<ConnectorIcon displayName={displayName} iconUrl={iconUrl} />}
          title={i18n.t("accountSelectionTitle", { name: displayName })}
        />
      </div>

      <ConnectorDialogSection title={i18n.t("permissionsTitle")}>
        <ConnectorPermissionList i18n={i18n} permissions={permissions} />
      </ConnectorDialogSection>

      {usesSecret ? (
        <ConnectorDialogSection title={i18n.t("secretInputTitle")}>
          <div className="space-y-2">
            <Input
              aria-label={i18n.t("secretInputTitle")}
              autoComplete="off"
              disabled={authorizing || pending}
              placeholder={i18n.t("secretInputPlaceholder")}
              type="password"
              value={secret}
              onChange={(event) => setSecret(event.currentTarget.value)}
            />
            <p className="m-0 text-[11px] leading-[1.45] text-[var(--text-tertiary)]">
              {i18n.t("secretInputDescription")}
            </p>
          </div>
        </ConnectorDialogSection>
      ) : null}

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
          disabled={authorizing || (usesSecret && !secret.trim())}
          size="dialog"
          type="button"
          onClick={() => {
            const submittedSecret = usesSecret ? secret : undefined;
            if (usesSecret) setSecret("");
            void onAuthorize(submittedSecret);
          }}
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
