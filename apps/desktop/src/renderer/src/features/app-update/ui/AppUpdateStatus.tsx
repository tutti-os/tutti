import { useEffect } from "react";
import {
  Button,
  DownloadIcon,
  LoadingIcon,
  RefreshIcon,
  StatusDot,
  WarningFilledIcon
} from "@tutti-os/ui-system";
import { useTranslation } from "@renderer/i18n";
import { cn } from "@renderer/lib/format";
import { useAppUpdateService } from "./useAppUpdateService";

export function AppUpdateStatus({
  density = "default"
}: {
  density?: "compact" | "default";
}) {
  const { t } = useTranslation();
  const { service, state } = useAppUpdateService();

  useEffect(() => {
    void service.load();
  }, [service]);

  const view = state.view;

  if (!view.visible || !view.titleKey) {
    return null;
  }

  const label = t(view.titleKey, view.titleParams);
  const compact = density === "compact";
  const isError = view.tone === "error";
  const statusTone = isError ? "red" : "green";

  return (
    <div
      className={cn(
        "relative isolate inline-flex max-w-[min(20rem,34vw)] items-center justify-between overflow-hidden rounded-[14px] border transition-[background,border-color,box-shadow]",
        compact
          ? "gap-2 px-2.5 py-1.5 text-[11px]"
          : "gap-2.5 px-3 py-1.5 text-[13px] max-[700px]:max-w-[calc(100vw-12rem)] max-[700px]:gap-2 max-[700px]:px-2.5 max-[700px]:text-[12px]",
        isError
          ? "border-[color-mix(in_srgb,var(--state-danger)_34%,transparent)] bg-[rgb(45_18_22_/_0.72)] text-white shadow-[inset_0_1px_0_rgb(255_255_255_/_0.10),0_10px_22px_rgb(2_8_23_/_0.18)] supports-backdrop-filter:backdrop-blur-xl"
          : "border-white/12 bg-[rgb(12_24_40_/_0.68)] text-white shadow-[inset_0_1px_0_rgb(255_255_255_/_0.12),0_10px_22px_rgb(2_8_23_/_0.20)] supports-backdrop-filter:backdrop-blur-xl"
      )}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-[1] bg-[linear-gradient(180deg,rgb(255_255_255_/_0.09),rgb(255_255_255_/_0.02))]"
      />
      <div className="flex min-w-0 items-center gap-2.5 max-[700px]:gap-2">
        <span
          aria-hidden="true"
          className={cn(
            "relative grid shrink-0 place-items-center rounded-full",
            compact ? "size-5" : "size-6 max-[700px]:size-5"
          )}
        >
          <span
            className={cn(
              "absolute inset-0 rounded-full",
              isError
                ? "bg-[color-mix(in_srgb,var(--state-danger)_18%,transparent)]"
                : "bg-[color-mix(in_srgb,var(--state-success)_20%,transparent)]"
            )}
          />
          {view.icon === "loading" ? (
            <LoadingIcon
              className={cn(
                "relative animate-spin",
                compact ? "size-3" : "size-3.5 max-[700px]:size-3"
              )}
            />
          ) : view.icon === "alert" ? (
            <WarningFilledIcon
              className={cn(
                "relative",
                compact ? "size-3" : "size-3.5 max-[700px]:size-3"
              )}
            />
          ) : (
            <StatusDot
              className={cn(
                "relative shadow-[0_0_0_3px_rgb(255_255_255_/_0.05),0_0_14px_currentColor]",
                compact ? "size-2" : "size-2.5 max-[700px]:size-2"
              )}
              pulse
              size="sm"
              tone={statusTone}
            />
          )}
        </span>
        <div className="min-w-0">
          <p className="truncate font-semibold whitespace-nowrap text-white [text-shadow:0_1px_2px_rgb(0_0_0_/_0.28)]">
            {label}
          </p>
          {view.progressPercent !== null ? (
            <div
              className={cn(
                "max-w-full overflow-hidden rounded-full bg-white/12",
                compact ? "mt-1.5 h-1 w-28" : "mt-1.5 h-1 w-52 max-[700px]:w-28"
              )}
            >
              <div
                className={cn(
                  "h-full rounded-full transition-[width]",
                  isError
                    ? "bg-[var(--state-danger)]"
                    : "bg-[var(--state-success)]"
                )}
                style={{
                  width: `${view.progressPercent}%`
                }}
              />
            </div>
          ) : null}
        </div>
      </div>

      {view.action && view.actionKey ? (
        <Button
          disabled={view.busy}
          onClick={() => {
            void service.runPrimaryAction();
          }}
          size={compact ? "xs" : "sm"}
          variant="outline"
          className={cn(
            "border text-white shadow-[inset_0_0_0_1px_rgb(255_255_255_/_0.06)] hover:text-white focus-visible:ring-2 disabled:opacity-60",
            compact
              ? "h-6 rounded-[7px] px-2 text-[11px]"
              : "h-6 rounded-[7px] px-2.5 text-[12px] font-semibold max-[700px]:px-2",
            isError
              ? "border-[color-mix(in_srgb,var(--state-danger)_58%,transparent)] bg-[color-mix(in_srgb,var(--state-danger)_12%,transparent)] hover:bg-[color-mix(in_srgb,var(--state-danger)_18%,transparent)] focus-visible:ring-[color-mix(in_srgb,var(--state-danger)_35%,transparent)]"
              : "border-[color-mix(in_srgb,var(--state-success)_58%,transparent)] bg-[color-mix(in_srgb,var(--state-success)_8%,transparent)] hover:bg-[color-mix(in_srgb,var(--state-success)_14%,transparent)] focus-visible:ring-[color-mix(in_srgb,var(--state-success)_35%,transparent)]"
          )}
        >
          {state.isActing ? (
            <LoadingIcon
              className={cn(
                "animate-spin",
                compact ? "size-3" : "size-4 max-[700px]:size-3.5"
              )}
            />
          ) : view.action === "download" ? (
            <DownloadIcon
              className={cn(compact ? "size-3" : "size-3.5 max-[700px]:size-3")}
            />
          ) : (
            <RefreshIcon
              className={cn(compact ? "size-3" : "size-3.5 max-[700px]:size-3")}
            />
          )}
          {t(view.actionKey)}
        </Button>
      ) : null}
    </div>
  );
}
