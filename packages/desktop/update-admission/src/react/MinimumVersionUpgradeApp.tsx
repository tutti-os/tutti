import { useEffect, useState } from "react";
import { Button, CloseIcon, LoadingIcon } from "@tutti-os/ui-system";
import type {
  DesktopMinimumVersionApi,
  MinimumVersionUpgradeError,
  MinimumVersionUpgradeState
} from "../contracts/index.ts";
import type { MinimumVersionAdmissionI18nRuntime } from "../i18n/index.ts";

function percent(value: number | null): string {
  return `${Math.max(0, Math.min(100, Math.round(value ?? 0)))}%`;
}

export function MinimumVersionUpgradeApp(props: {
  i18n: MinimumVersionAdmissionI18nRuntime;
  mode: "startup" | "foreground";
  port: DesktopMinimumVersionApi;
  productName: string;
}) {
  const { i18n, mode, port, productName } = props;
  const [state, setState] = useState<MinimumVersionUpgradeState | null>(null);
  const [pending, setPending] = useState(false);
  const t = (
    key: Parameters<MinimumVersionAdmissionI18nRuntime["t"]>[0]
  ): string => i18n.t(key, { productName });

  useEffect(() => {
    let disposed = false;
    void port.getState().then((value) => {
      if (!disposed) {
        setState(value);
      }
    });
    const unsubscribe = port.onState(setState);
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [port]);

  const run = (operation: () => Promise<unknown>): void => {
    setPending(true);
    void operation()
      .catch(() => undefined)
      .finally(() => setPending(false));
  };

  if (!state) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[var(--background)] text-[var(--foreground)]">
        <LoadingIcon className="size-6 animate-spin" />
      </main>
    );
  }

  const prompt = mode === "foreground" && state.phase === "blocked";
  const checking = state.phase === "checking";
  const downloading = state.phase === "downloading";
  const failed = state.phase === "error";
  const simulationComplete = state.phase === "simulationComplete";
  const title = simulationComplete
    ? t("simulationCompleteTitle")
    : prompt
      ? t("foregroundTitle")
      : failed
        ? t("failedTitle")
        : downloading
          ? t("downloadingTitle")
          : checking
            ? t("checkingTitle")
            : t("startupTitle");
  const errorKey =
    `errors.${state.message ?? "updateFailed"}` as `errors.${MinimumVersionUpgradeError}`;

  return (
    <main className="relative flex min-h-screen items-center justify-center bg-[var(--card)] p-8 text-[var(--foreground)]">
      <Button
        aria-label={t("exit")}
        className="absolute top-3 left-3"
        disabled={pending}
        size="icon-sm"
        title={t("exit")}
        variant="ghost"
        onClick={() => run(() => port.exit())}
      >
        <CloseIcon />
      </Button>
      <section className="w-full max-w-[440px]">
        <h1 className="text-lg font-semibold">{title}</h1>
        <p className="mt-2 text-sm leading-5 text-[var(--muted-foreground)]">
          {simulationComplete
            ? t("simulationCompleteDetail")
            : prompt
              ? t("foregroundDetail")
              : failed
                ? t(errorKey)
                : t("startupDetail")}
        </p>
        {failed && state.update.message ? (
          <p className="mt-2 break-words text-xs leading-5 text-[var(--destructive)]">
            {state.update.message}
          </p>
        ) : null}
        <dl className="mt-6 grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1 text-sm">
          <dt className="text-[var(--muted-foreground)]">
            {t("currentVersion")}
          </dt>
          <dd className="tabular-nums">{state.check.currentVersion}</dd>
          <dt className="text-[var(--muted-foreground)]">
            {t("minimumVersion")}
          </dt>
          <dd className="tabular-nums">{state.check.minimumVersion}</dd>
        </dl>
        {downloading ? (
          <div className="mt-5">
            <div className="mb-2 flex justify-between text-xs text-[var(--muted-foreground)]">
              <span>{t("downloadProgress")}</span>
              <span className="tabular-nums">
                {percent(state.update.downloadPercent)}
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-[var(--muted)]">
              <div
                className="h-full bg-[var(--primary)] transition-[width]"
                style={{ width: percent(state.update.downloadPercent) }}
              />
            </div>
            <p className="mt-3 text-xs text-[var(--muted-foreground)]">
              {t("autoRestartNotice")}
            </p>
          </div>
        ) : null}
        <div className="mt-6 flex flex-wrap justify-end gap-2">
          {simulationComplete ? (
            <Button
              variant="secondary"
              disabled={pending}
              onClick={() => run(() => port.restart())}
            >
              {t("restart")}
            </Button>
          ) : null}
          {failed ? (
            <>
              <Button
                variant="secondary"
                disabled={pending}
                onClick={() => run(() => port.exit())}
              >
                {t("exit")}
              </Button>
              <Button
                variant="secondary"
                disabled={pending}
                onClick={() => run(() => port.openManualDownload())}
              >
                {t("manualDownload")}
              </Button>
              <Button
                disabled={pending}
                onClick={() => run(() => port.retry())}
              >
                {t("retry")}
              </Button>
            </>
          ) : state.phase === "blocked" ? (
            <Button disabled={pending} onClick={() => run(() => port.start())}>
              {t("upgradeNow")}
            </Button>
          ) : null}
        </div>
      </section>
    </main>
  );
}
