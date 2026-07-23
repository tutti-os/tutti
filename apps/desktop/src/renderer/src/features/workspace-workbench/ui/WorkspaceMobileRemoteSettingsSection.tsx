import { LoadingIcon } from "@tutti-os/ui-system";
import qrcode from "qrcode-generator";
import { useEffect, useState } from "react";
import { useTranslation } from "@renderer/i18n";
import { WorkspaceSettingsActionButton } from "./WorkspaceSettingsActionButton";
import { useMobileRemoteAccessService } from "./useMobileRemoteAccessService";

export function WorkspaceMobileRemoteSettingsSection() {
  const { t } = useTranslation();
  const { service, state } = useMobileRemoteAccessService();
  const [qrDataURL, setQRDataURL] = useState<string | null>(null);
  const [qrRenderFailed, setQRRenderFailed] = useState(false);

  useEffect(() => {
    void service.refreshPairings();
    return () => service.cancelPairing();
  }, [service]);

  useEffect(() => {
    let active = true;
    setQRRenderFailed(false);
    if (!state.qrPayload) {
      setQRDataURL(null);
      return () => {
        active = false;
      };
    }
    try {
      const code = qrcode(0, "M");
      code.addData(state.qrPayload);
      code.make();
      if (active) {
        setQRDataURL(code.createDataURL(6, 12));
      }
    } catch {
      if (active) {
        setQRDataURL(null);
        setQRRenderFailed(true);
      }
    }
    return () => {
      active = false;
    };
  }, [state.qrPayload]);

  const pairingActive = Boolean(state.qrPayload);
  const errorMessage = state.error
    ? {
        list: t("workspace.settings.account.mobileRemote.errors.list"),
        revoke: t("workspace.settings.account.mobileRemote.errors.revoke"),
        start: t("workspace.settings.account.mobileRemote.errors.start"),
        status: t("workspace.settings.account.mobileRemote.errors.status")
      }[state.error]
    : null;
  const statusLabel = state.confirming
    ? t("workspace.settings.account.mobileRemote.confirming")
    : state.challenge?.state === "awaiting_confirmation"
      ? t("workspace.settings.account.mobileRemote.confirming")
      : t("workspace.settings.account.mobileRemote.waitingForScan");

  return (
    <section className="flex flex-col gap-4 border-t border-[var(--border-subtle)] pt-5">
      <div className="flex items-start justify-between gap-4 max-[560px]:flex-col">
        <div className="min-w-0">
          <h3 className="m-0 text-[14px] font-semibold text-[var(--text-primary)]">
            {t("workspace.settings.account.mobileRemote.title")}
          </h3>
          <p className="mb-0 mt-1 max-w-[560px] text-[13px] leading-5 text-[var(--text-secondary)]">
            {t("workspace.settings.account.mobileRemote.description")}
          </p>
        </div>
        <WorkspaceSettingsActionButton
          className="w-auto min-w-[112px] max-[560px]:w-full"
          disabled={state.starting || state.confirming}
          icon={state.starting ? <LoadingIcon className="size-3.5" /> : null}
          label={
            pairingActive
              ? t("workspace.settings.account.mobileRemote.cancel")
              : state.starting
                ? t("workspace.settings.account.mobileRemote.starting")
                : t("workspace.settings.account.mobileRemote.start")
          }
          onClick={() => {
            if (pairingActive) {
              service.cancelPairing();
            } else {
              void service.startPairing();
            }
          }}
          variant={pairingActive ? "secondary" : "default"}
        />
      </div>

      {pairingActive ? (
        <div className="flex items-center gap-5 rounded-[10px] bg-[var(--transparency-block)] p-4 max-[560px]:flex-col">
          <div className="grid size-[224px] shrink-0 place-items-center overflow-hidden rounded-[8px] bg-white">
            {qrDataURL ? (
              <img
                alt={t("workspace.settings.account.mobileRemote.qrAlt")}
                className="size-[224px]"
                draggable={false}
                src={qrDataURL}
              />
            ) : qrRenderFailed ? (
              <span className="px-4 text-center text-[12px] text-black">
                {t("workspace.settings.account.mobileRemote.qrError")}
              </span>
            ) : (
              <LoadingIcon className="size-5 text-black" />
            )}
          </div>
          <div className="min-w-0">
            <strong className="text-[14px] font-semibold text-[var(--text-primary)]">
              {statusLabel}
            </strong>
            <p className="mb-0 mt-2 text-[13px] leading-5 text-[var(--text-secondary)]">
              {t("workspace.settings.account.mobileRemote.scanHint")}
            </p>
          </div>
        </div>
      ) : null}

      {errorMessage ? (
        <p className="m-0 rounded-[6px] bg-[color-mix(in_srgb,var(--state-warning)_16%,transparent)] px-3 py-2 text-[13px] text-[var(--text-primary)]">
          {errorMessage}
        </p>
      ) : null}

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <strong className="text-[13px] font-medium text-[var(--text-primary)]">
            {t("workspace.settings.account.mobileRemote.pairedDevices")}
          </strong>
          {state.loadingPairings ? (
            <LoadingIcon className="size-3.5 text-[var(--text-secondary)]" />
          ) : null}
        </div>
        {!state.loadingPairings && state.pairings.length === 0 ? (
          <p className="m-0 text-[13px] text-[var(--text-secondary)]">
            {t("workspace.settings.account.mobileRemote.empty")}
          </p>
        ) : null}
        {state.pairings.map((pairing) => (
          <div
            className="flex items-center justify-between gap-3 rounded-[8px] bg-[var(--transparency-block)] px-3 py-2.5"
            key={pairing.pairingId}
          >
            <div className="min-w-0">
              <strong className="block truncate text-[13px] font-medium text-[var(--text-primary)]">
                {t("workspace.settings.account.mobileRemote.mobileDevice")}
              </strong>
              <span className="block truncate text-[12px] text-[var(--text-tertiary)]">
                {pairing.controllerUserDeviceId}
              </span>
            </div>
            {pairing.state === "active" ? (
              <WorkspaceSettingsActionButton
                className="w-auto min-w-[84px]"
                disabled={Boolean(state.revokingPairingID)}
                label={
                  state.revokingPairingID === pairing.pairingId
                    ? t("workspace.settings.account.mobileRemote.removing")
                    : t("workspace.settings.account.mobileRemote.remove")
                }
                onClick={() => void service.revokePairing(pairing.pairingId)}
                variant="destructive-secondary"
              />
            ) : (
              <span className="text-[12px] text-[var(--text-tertiary)]">
                {t("workspace.settings.account.mobileRemote.revoked")}
              </span>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
