import {
  Button,
  ChromeIcon,
  CloseIcon,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  toast
} from "@tutti-os/ui-system";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { JSX } from "react";
import type { BrowserNodeFeature } from "../core/feature.ts";
import { BrowserNodeChromeImportDialog } from "./BrowserNodeChromeImportDialog.tsx";
import {
  browserNodeCookieImportFeedback,
  shouldShowChromeImportPrompt
} from "./chromeCookieImportUiModel.ts";

export function BrowserNodeChromeImportPrompt({
  feature,
  nodeId
}: {
  feature: BrowserNodeFeature;
  nodeId: string;
}): JSX.Element | null {
  const chromeImport = feature.chromeCookieImport;
  const [dialogOpen, setDialogOpen] = useState(false);
  const state = useSyncExternalStore(
    chromeImport?.subscribe ?? emptySubscribe,
    chromeImport?.getSnapshot ?? idleSnapshot,
    idleSnapshot
  );
  const dismissed = useSyncExternalStore(
    chromeImport?.prompt?.subscribe ?? emptySubscribe,
    chromeImport?.prompt?.isDismissed ?? alwaysDismissed,
    alwaysDismissed
  );

  useEffect(() => {
    if (chromeImport?.prompt && !dismissed && state.status === "idle") {
      void chromeImport.discover();
    }
  }, [chromeImport, dismissed, state.status]);

  if (
    !chromeImport?.prompt ||
    state.status !== "available" ||
    !shouldShowChromeImportPrompt({
      dismissed,
      hasPromptAdapter: true,
      state
    })
  ) {
    return null;
  }

  return (
    <>
      <div
        className="flex min-h-[68px] shrink-0 items-center gap-3 border-b border-border bg-[var(--transparency-block)] px-4 py-2.5"
        data-browser-node-chrome-import-prompt="true"
      >
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[var(--background-panel)] text-[var(--text-primary)] shadow-sm">
          <ChromeIcon className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold text-[var(--text-primary)]">
            {feature.i18n.t("chromeImport.promptTitle")}
          </div>
          <div className="mt-0.5 text-[11px] leading-4 text-[var(--text-secondary)]">
            {feature.i18n.t("chromeImport.promptDescription")}
          </div>
        </div>
        <Button size="sm" type="button" onClick={() => setDialogOpen(true)}>
          {feature.i18n.t("chromeImport.selectProfile")}
        </Button>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-label={feature.i18n.t("chromeImport.dismissTooltip")}
              size="icon-sm"
              type="button"
              variant="chrome"
              onClick={() => chromeImport.prompt?.dismiss()}
            >
              <CloseIcon className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {feature.i18n.t("chromeImport.dismissTooltip")}
          </TooltipContent>
        </Tooltip>
      </div>
      <BrowserNodeChromeImportDialog
        feature={feature}
        nodeId={nodeId}
        open={dialogOpen}
        profiles={state.profiles}
        onOpenChange={setDialogOpen}
        onResult={(result) => {
          const feedback = browserNodeCookieImportFeedback(feature, result);
          if (!feedback) {
            return;
          }
          if (feedback.tone === "success") {
            toast.success(feedback.message);
          } else if (feedback.tone === "error") {
            toast.error(feedback.message);
          } else {
            toast.warning(feedback.message);
          }
        }}
      />
    </>
  );
}

const idleState = { status: "idle" } as const;
function idleSnapshot(): typeof idleState {
  return idleState;
}
function emptySubscribe(): () => void {
  return () => undefined;
}
function alwaysDismissed(): boolean {
  return true;
}
