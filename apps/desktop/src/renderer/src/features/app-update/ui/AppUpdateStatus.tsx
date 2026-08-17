import { useEffect, useState } from "react";
import {
  Button,
  DownloadIcon,
  LoadingIcon,
  RefreshIcon
} from "@tutti-os/ui-system";
import { useTranslation } from "@renderer/i18n";
import { cn } from "@renderer/lib/format";
import { useAppUpdateService } from "./useAppUpdateService";
import { resolveStandaloneAppUpdateStatusPresentation } from "./appUpdateStatusPresentation";

const updateIconUrl = new URL("../assets/update.png", import.meta.url).href;
const tuttiIconUrl = new URL("../assets/tutti.png", import.meta.url).href;

export function AppUpdateStatus({
  density = "default",
  presentation = "workspace"
}: {
  density?: "compact" | "default";
  presentation?: "standalone" | "workspace";
}) {
  const { t } = useTranslation();
  const { service, state } = useAppUpdateService();

  const view = state.view;

  if (presentation === "standalone") {
    return (
      <StandaloneAppUpdateStatus
        isActing={state.isActing}
        runPrimaryAction={() => service.runPrimaryAction()}
        view={view}
      />
    );
  }

  if (!view.visible || !view.titleKey) {
    return null;
  }

  const label = t(view.titleKey, view.titleParams);
  const compact = density === "compact";

  return (
    <div
      className={cn(
        "inline-flex h-7 max-w-[min(18rem,30vw)] items-center justify-between",
        compact
          ? "gap-1.5 text-[13px]"
          : "gap-2.5 text-[13px] max-[700px]:max-w-[calc(100vw-12rem)] max-[700px]:gap-2"
      )}
    >
      <div className="flex h-7 min-w-0 items-center gap-1.5">
        <RotatingUpdateIcon />
        <span className="inline-flex h-7 min-w-0 items-center truncate whitespace-nowrap text-[13px] font-semibold text-[var(--workbench-chrome-foreground)]">
          {label}
        </span>
      </div>

      {view.action && view.actionKey ? (
        <>
          {state.updateState?.releaseNotesUrl ? (
            <Button
              onClick={() => void service.openReleaseNotes()}
              size={compact ? "xs" : "sm"}
              type="button"
              variant="ghost"
            >
              {t("updates.releaseNotesAction")}
            </Button>
          ) : null}
          <Button
            disabled={view.busy}
            onClick={() => {
              void service.runPrimaryAction();
            }}
            size={compact ? "xs" : "sm"}
            variant="secondary"
            className={cn(
              "text-[var(--workbench-chrome-foreground)] hover:text-[var(--workbench-chrome-foreground)] disabled:opacity-60",
              compact
                ? "h-7 rounded-[4px] px-2 text-[13px] font-semibold"
                : "h-7 rounded-[4px] px-2.5 text-[13px] font-semibold max-[700px]:px-2"
            )}
          >
            {state.isActing ? (
              <LoadingIcon
                className={cn(
                  "animate-spin",
                  compact ? "size-3" : "size-4 max-[700px]:size-3.5"
                )}
              />
            ) : null}
            <span>{t(view.actionKey)}</span>
          </Button>
        </>
      ) : null}
    </div>
  );
}

function StandaloneAppUpdateStatus({
  isActing,
  runPrimaryAction,
  view
}: {
  isActing: boolean;
  runPrimaryAction(): Promise<void>;
  view: ReturnType<typeof useAppUpdateService>["state"]["view"];
}) {
  const { t } = useTranslation();
  const presentation = resolveStandaloneAppUpdateStatusPresentation(view);

  if (!presentation) {
    return null;
  }

  const title = t(presentation.titleKey, presentation.titleParams);
  if (presentation.kind === "status") {
    return (
      <span
        aria-label={title}
        className="inline-flex h-7 items-center gap-1.5 text-[13px] font-medium text-[var(--text-secondary)] [-webkit-app-region:no-drag]"
        role="status"
      >
        <LoadingIcon aria-hidden className="size-3.5 animate-spin" />
        <span>{title}</span>
      </span>
    );
  }

  const actionLabel = t(presentation.actionKey);
  return (
    <Button
      aria-label={`${title}: ${actionLabel}`}
      className="h-7 gap-1 rounded-[6px] px-2 text-[13px] font-semibold [-webkit-app-region:no-drag]"
      disabled={isActing}
      size="xs"
      title={title}
      type="button"
      variant="secondary"
      onClick={() => {
        void runPrimaryAction();
      }}
    >
      {isActing ? (
        <LoadingIcon aria-hidden className="size-3 animate-spin" />
      ) : presentation.actionKey === "updates.downloadAction" ? (
        <DownloadIcon aria-hidden className="size-3.5" />
      ) : (
        <RefreshIcon aria-hidden className="size-3.5" />
      )}
      <span>{actionLabel}</span>
    </Button>
  );
}

function RotatingUpdateIcon() {
  const [previousUrl, setPreviousUrl] = useState(updateIconUrl);
  const [currentUrl, setCurrentUrl] = useState(updateIconUrl);
  const [rolling, setRolling] = useState(false);

  useEffect(() => {
    let settleTimeout: number | null = null;
    const interval = window.setInterval(() => {
      setCurrentUrl((current) => {
        const next = current === updateIconUrl ? tuttiIconUrl : updateIconUrl;
        setPreviousUrl(current);
        setRolling(true);

        if (settleTimeout !== null) {
          window.clearTimeout(settleTimeout);
        }

        settleTimeout = window.setTimeout(() => {
          setRolling(false);
        }, 260);

        return next;
      });
    }, 3000);

    return () => {
      window.clearInterval(interval);
      if (settleTimeout !== null) {
        window.clearTimeout(settleTimeout);
      }
    };
  }, []);

  return (
    <span className="inline-flex h-7 w-5 shrink-0 items-center justify-center">
      <span className="relative inline-flex size-5 overflow-hidden [perspective:80px]">
        <img
          aria-hidden="true"
          alt=""
          className={cn(
            "absolute inset-0 size-5 object-contain [backface-visibility:hidden] [transform-origin:center_bottom] motion-reduce:transition-none",
            rolling
              ? "transition-[opacity,transform] duration-[260ms] ease-out"
              : "transition-none",
            rolling
              ? "opacity-0 [transform:rotateX(-88deg)]"
              : "opacity-100 [transform:rotateX(0deg)]"
          )}
          draggable={false}
          src={rolling ? previousUrl : currentUrl}
        />
        <img
          aria-hidden="true"
          alt=""
          className={cn(
            "absolute inset-0 size-5 object-contain [backface-visibility:hidden] [transform-origin:center_top] motion-reduce:transition-none",
            rolling
              ? "transition-[opacity,transform] duration-[260ms] ease-out"
              : "transition-none",
            rolling
              ? "opacity-100 [transform:rotateX(0deg)]"
              : "opacity-0 [transform:rotateX(88deg)]"
          )}
          draggable={false}
          src={currentUrl}
        />
      </span>
    </span>
  );
}
