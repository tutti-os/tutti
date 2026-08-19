import {
  Button,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Spinner
} from "@tutti-os/ui-system/components";
import { ChangeLined, TuttiMarkNew } from "@tutti-os/ui-system/icons";

import {
  validateAuthorizationEventForViewV1,
  type AuthorizationEventEnvelopeV1,
  type AuthorizationViewEnvelopeV1
} from "@tutti-os/connector-contracts/authorization/v1";

import {
  DefaultAuthorizationViewRenderer,
  type AuthorizationViewRenderer
} from "../authorization/AuthorizationViewRenderer.tsx";
import {
  resolveAuthorizationInteraction,
  resolveDeclarativeAuthorizationSubmission
} from "../../application/authorization/declarativeAuthorizationAdapter.ts";
import type { ConnectorMarketI18nRuntime } from "../i18n/connectorMarketI18n.ts";
import { ConnectorIcon } from "../catalog/ConnectorIcon.tsx";
import { ConnectorDialogInfoRow } from "./ConnectorDialogInfoRow.tsx";

export interface ConnectorAuthorizationDialogProps {
  authorizationInteraction?: unknown;
  authorizationKind: string;
  authorizationRenderer?: AuthorizationViewRenderer;
  authorizationView?: AuthorizationViewEnvelopeV1;
  authorizing: boolean;
  brokeredAuthorization: boolean;
  displayName: string;
  iconUrl: string;
  i18n: ConnectorMarketI18nRuntime;
  locale: string;
  onAuthorize: (secret?: string) => Promise<void>;
  onCancel: () => void;
  onClose: () => void;
  onOpenAuthorizationUrl: (url: string) => Promise<void>;
  pending: boolean;
}

export function ConnectorAuthorizationDialog({
  authorizationInteraction,
  authorizationKind,
  authorizationRenderer:
    AuthorizationRenderer = DefaultAuthorizationViewRenderer,
  authorizationView,
  authorizing,
  brokeredAuthorization,
  displayName,
  iconUrl,
  i18n,
  locale,
  onAuthorize,
  onCancel,
  onClose,
  onOpenAuthorizationUrl,
  pending
}: ConnectorAuthorizationDialogProps) {
  const resolved = resolveAuthorizationInteraction({
    authorizationKind,
    enableLegacySecretFallback: !brokeredAuthorization,
    interaction: authorizationInteraction,
    legacyLabels: {
      description: i18n.t("secretInputDescription"),
      fieldLabel: i18n.t("secretInputTitle"),
      placeholder: i18n.t("secretInputPlaceholder")
    },
    locale
  });
  const currentView =
    authorizationView ?? (resolved.kind === "form" ? resolved.view : null);

  const handleInteractionEvent = (event: AuthorizationEventEnvelopeV1) => {
    if (!currentView) return;
    const validated = validateAuthorizationEventForViewV1(currentView, event, {
      isCurrentLocalFileHandle: () => false
    });
    if (!validated.ok) return;
    if (validated.value.event.type === "cancel") {
      onCancel();
      return;
    }
    if (validated.value.event.type === "activate") {
      const view = currentView.view;
      const url =
        view.type === "device_code"
          ? view.verificationUrl
          : view.type === "external_link"
            ? view.url
            : null;
      if (url) void onOpenAuthorizationUrl(url);
      return;
    }
    if (authorizationView || resolved.kind !== "form") return;
    const submission = resolveDeclarativeAuthorizationSubmission(
      resolved,
      validated.value
    );
    if (submission.ok) {
      void onAuthorize(submission.secret);
    }
  };

  return (
    <DialogContent className="max-h-[min(720px,calc(100vh-32px))] overflow-y-auto sm:max-w-[420px]">
      <DialogHeader className="gap-3 px-5 pt-4 text-center">
        <div className="gap-3 flex items-center justify-center">
          <span className="flex size-12 items-center justify-center rounded-xl bg-[var(--transparency-block)] text-[var(--accent)]">
            <TuttiMarkNew size={32} />
          </span>
          <ChangeLined className="size-4 text-[var(--text-tertiary)]" />
          <ConnectorIcon
            displayName={displayName}
            iconUrl={iconUrl}
            size="lg"
          />
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

      <div className="mt-3 overflow-hidden rounded-lg border border-[var(--border-1)]">
        <ConnectorDialogInfoRow
          description={i18n.t("accountSelectionDescription")}
          icon={<ConnectorIcon displayName={displayName} iconUrl={iconUrl} />}
          title={i18n.t("accountSelectionTitle", { name: displayName })}
        />
      </div>

      {currentView ? (
        <AuthorizationRenderer
          busy={authorizationView ? false : authorizing || pending}
          labels={{
            activate: i18n.t("actionContinueAuthorization"),
            cancel: i18n.t("cancel"),
            refresh: i18n.t("actionRefresh"),
            qrCodeAlt: i18n.t("authorizationQrCodeAlt"),
            retry: i18n.t("actionRetry"),
            submit: i18n.t("actionAuthorize"),
            unsupportedField: i18n.t("unsupportedAuthorizationField")
          }}
          view={currentView}
          onEvent={handleInteractionEvent}
        />
      ) : resolved.kind === "invalid" ? (
        <>
          <p className="m-0 text-sm text-[var(--text-secondary)]">
            {i18n.t("connectorAuthorizationConfigurationInvalid")}
          </p>
          <DialogFooter className="pt-1 sm:justify-center">
            <Button
              size="dialog"
              type="button"
              variant="secondary"
              onClick={onClose}
            >
              {i18n.t("close")}
            </Button>
          </DialogFooter>
        </>
      ) : (
        <DialogFooter className="pt-1 sm:justify-center">
          <Button
            size="dialog"
            type="button"
            variant="secondary"
            onClick={onCancel}
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
      )}
      <p className="text-center text-[11px] text-[var(--text-tertiary)] leading-[1.5]">
        {i18n.t("exactAccessNotice")}
      </p>
    </DialogContent>
  );
}
