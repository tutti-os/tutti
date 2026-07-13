import {
  ArrowRightIcon,
  Button,
  ChevronDownIcon,
  ChevronUpIcon,
  CloseIcon,
  ConfirmationDialog,
  DeleteIcon,
  DownloadIcon,
  Input,
  LaunchIcon,
  LocateFolderIcon,
  MenuSurface,
  MoreHorizontalIcon,
  PauseIcon,
  PlayIcon
} from "@tutti-os/ui-system";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { JSX, KeyboardEvent } from "react";
import type { BrowserNodeFeature } from "../core/feature.ts";
import type {
  BrowserNodeDevicePreset,
  BrowserNodeDownloadAction,
  BrowserNodeDownloadState,
  BrowserNodeRuntimeState,
  BrowserNodeScreenshotMode
} from "../core/types.ts";
import { BrowserNodeSettingsDialog } from "./BrowserNodeSettingsDialog.tsx";
import {
  BrowserNodeMenuItem,
  BrowserNodeMenuPanelHeader,
  BrowserNodeMenuSeparator
} from "./BrowserNodeMenuPrimitives.tsx";
import { setBrowserNodeHostOverlayOwnerOpen } from "./browserNodeHostOverlayStore.ts";

const browserZoomStep = 0.1;

type BrowserNodeActionsMenuPanel =
  | "main"
  | "find"
  | "device"
  | "screenshot"
  | "downloads";

export function BrowserNodeActionsMenu({
  feature,
  nodeId,
  onOpenDevTools,
  runtime
}: {
  feature: BrowserNodeFeature;
  nodeId: string;
  onOpenDevTools?: () => void;
  runtime: BrowserNodeRuntimeState;
}): JSX.Element {
  const [findText, setFindText] = useState(runtime.findResult?.query ?? "");
  const [clearDialogOpen, setClearDialogOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPanel, setMenuPanel] =
    useState<BrowserNodeActionsMenuPanel>("main");
  const [clearBusy, setClearBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [devicePreset, setDevicePreset] =
    useState<BrowserNodeDevicePreset>("desktop");
  const [screenshotMode, setScreenshotMode] =
    useState<BrowserNodeScreenshotMode>("visible");
  const [downloadDirectory, setDownloadDirectory] = useState<string | null>(
    null
  );
  const hostApi = feature.hostApi;
  const overlayOwnerId = useId();
  const menuSurfaceRef = useRef<HTMLDivElement | null>(null);
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const hostOverlayOpen = clearDialogOpen || settingsOpen;

  useLayoutEffect(() => {
    setBrowserNodeHostOverlayOwnerOpen({
      nodeId,
      open: hostOverlayOpen,
      ownerId: overlayOwnerId
    });
    return () => {
      setBrowserNodeHostOverlayOwnerOpen({
        nodeId,
        open: false,
        ownerId: overlayOwnerId
      });
    };
  }, [hostOverlayOpen, nodeId, overlayOwnerId]);

  useEffect(() => {
    if (runtime.findResult?.query === "") {
      setFindText("");
    }
  }, [runtime.findResult?.query]);

  useEffect(() => {
    if (!menuOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent): void => {
      if (!(event.target instanceof Node)) {
        return;
      }
      if (
        menuSurfaceRef.current?.contains(event.target) ||
        menuTriggerRef.current?.contains(event.target)
      ) {
        return;
      }
      setMenuOpen(false);
      setMenuPanel("main");
    };
    const handleKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== "Escape") {
        return;
      }
      setMenuOpen(false);
      setMenuPanel("main");
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [menuOpen]);

  const runAction = (event: string, action: () => Promise<unknown>): void => {
    void action().catch((error: unknown) => {
      feature.reportDiagnostic?.({
        details: {
          error: error instanceof Error ? error.message : String(error),
          nodeId
        },
        event,
        level: "warn"
      });
    });
  };

  const find = (input: { findNext: boolean; forward: boolean }): void => {
    if (!hostApi.findInPage) {
      return;
    }
    runAction(
      "find-in-page-failed",
      () =>
        hostApi.findInPage?.({ nodeId, text: findText, ...input }) ??
        Promise.resolve()
    );
  };

  const stopFind = (): void => {
    setFindText("");
    if (hostApi.stopFindInPage) {
      runAction(
        "stop-find-in-page-failed",
        () => hostApi.stopFindInPage?.({ nodeId }) ?? Promise.resolve()
      );
    }
  };

  const setZoom = (zoomFactor: number): void => {
    if (!hostApi.setZoomFactor) {
      return;
    }
    runAction(
      "set-zoom-factor-failed",
      () => hostApi.setZoomFactor?.({ nodeId, zoomFactor }) ?? Promise.resolve()
    );
  };

  const setDevicePresetForNode = (preset: BrowserNodeDevicePreset): void => {
    if (!hostApi.setDeviceEmulation) {
      return;
    }
    setDevicePreset(preset);
    runAction(
      "set-device-emulation-failed",
      () =>
        hostApi.setDeviceEmulation?.({ nodeId, preset }) ?? Promise.resolve()
    );
  };

  const saveScreenshot = (mode: BrowserNodeScreenshotMode): void => {
    if (!hostApi.saveScreenshot) {
      return;
    }
    runAction(
      "save-screenshot-failed",
      () => hostApi.saveScreenshot?.({ mode, nodeId }) ?? Promise.resolve()
    );
  };

  const performDownloadAction = (
    downloadId: string,
    action: BrowserNodeDownloadAction
  ): void => {
    if (!hostApi.performDownloadAction) {
      return;
    }
    runAction(
      "download-action-failed",
      () =>
        hostApi.performDownloadAction?.({ action, downloadId, nodeId }) ??
        Promise.resolve()
    );
  };

  const hasFind = Boolean(hostApi.findInPage && hostApi.stopFindInPage);
  const findResult = runtime.findResult;
  const zoomPercent = Math.round(runtime.zoomFactor * 100);
  const dismissMenu = (): void => {
    setMenuOpen(false);
    setMenuPanel("main");
  };
  const openMenu = (): void => {
    setMenuPanel("main");
    setMenuOpen(true);
  };

  return (
    <>
      <Button
        ref={menuTriggerRef}
        aria-expanded={menuOpen}
        aria-haspopup="menu"
        aria-label={feature.i18n.t("actions.more")}
        className="rounded-md"
        size="icon-sm"
        title={feature.i18n.t("actions.more")}
        type="button"
        variant="chrome"
        onClick={() => {
          if (menuOpen) {
            dismissMenu();
            return;
          }
          openMenu();
        }}
      >
        <MoreHorizontalIcon className="size-[15px] rotate-90" />
      </Button>
      {menuOpen ? (
        <MenuSurface
          ref={menuSurfaceRef}
          aria-label={feature.i18n.t("actions.more")}
          className="absolute top-[calc(100%+4px)] right-2 z-[var(--z-popover)] max-h-[min(560px,calc(100vh-24px))] w-[280px] max-w-[calc(100vw-24px)] overflow-y-auto"
          role="menu"
          onClick={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
        >
          {menuPanel === "main" ? (
            <>
              {hasFind ? (
                <BrowserNodeMenuItem
                  endAdornment={<ArrowRightIcon className="size-4" />}
                  onClick={() => setMenuPanel("find")}
                >
                  {feature.i18n.t("actions.findInPage")}
                </BrowserNodeMenuItem>
              ) : null}
              {hostApi.printPage ? (
                <BrowserNodeMenuItem
                  onClick={() => {
                    dismissMenu();
                    runAction(
                      "print-page-failed",
                      () => hostApi.printPage?.({ nodeId }) ?? Promise.resolve()
                    );
                  }}
                >
                  {feature.i18n.t("actions.print")}
                </BrowserNodeMenuItem>
              ) : null}
              {hostApi.setZoomFactor ? (
                <>
                  <BrowserNodeMenuSeparator />
                  <div className="flex items-center justify-between gap-3 px-2 py-1.5">
                    <span className="text-[13px] text-[var(--text-primary)]">
                      {feature.i18n.t("zoom.label")}
                    </span>
                    <div className="flex items-center gap-1">
                      <Button
                        aria-label={feature.i18n.t("zoom.decrease")}
                        disabled={runtime.zoomFactor <= 0.25}
                        size="icon-sm"
                        title={feature.i18n.t("zoom.decrease")}
                        type="button"
                        variant="chrome"
                        onClick={() =>
                          setZoom(runtime.zoomFactor - browserZoomStep)
                        }
                      >
                        <span
                          aria-hidden="true"
                          className="text-base leading-none"
                        >
                          −
                        </span>
                      </Button>
                      <Button
                        className="min-w-14 px-1 text-[12px]"
                        size="sm"
                        title={feature.i18n.t("zoom.reset")}
                        type="button"
                        variant="chrome"
                        onClick={() => setZoom(1)}
                      >
                        {zoomPercent}%
                      </Button>
                      <Button
                        aria-label={feature.i18n.t("zoom.increase")}
                        disabled={runtime.zoomFactor >= 5}
                        size="icon-sm"
                        title={feature.i18n.t("zoom.increase")}
                        type="button"
                        variant="chrome"
                        onClick={() =>
                          setZoom(runtime.zoomFactor + browserZoomStep)
                        }
                      >
                        <span
                          aria-hidden="true"
                          className="text-base leading-none"
                        >
                          +
                        </span>
                      </Button>
                    </div>
                  </div>
                </>
              ) : null}
              {hostApi.setDeviceEmulation ? (
                <BrowserNodeMenuItem
                  endAdornment={<ArrowRightIcon className="size-4" />}
                  onClick={() => setMenuPanel("device")}
                >
                  {feature.i18n.t("actions.deviceEmulation")}
                </BrowserNodeMenuItem>
              ) : null}
              {hostApi.saveScreenshot ? (
                <>
                  <BrowserNodeMenuItem
                    onClick={() => {
                      dismissMenu();
                      saveScreenshot(screenshotMode);
                    }}
                  >
                    {feature.i18n.t("actions.saveScreenshot")}
                  </BrowserNodeMenuItem>
                  <BrowserNodeMenuItem
                    endAdornment={<ArrowRightIcon className="size-4" />}
                    onClick={() => setMenuPanel("screenshot")}
                  >
                    {feature.i18n.t("actions.screenshotMode")}
                  </BrowserNodeMenuItem>
                </>
              ) : null}
              {hostApi.performDownloadAction ? (
                <>
                  <BrowserNodeMenuSeparator />
                  <BrowserNodeMenuItem
                    endAdornment={<ArrowRightIcon className="size-4" />}
                    onClick={() => setMenuPanel("downloads")}
                  >
                    {feature.i18n.t("actions.downloads")}
                  </BrowserNodeMenuItem>
                </>
              ) : null}
              {hostApi.clearBrowsingData ? (
                <BrowserNodeMenuItem
                  onClick={() => {
                    dismissMenu();
                    setClearDialogOpen(true);
                  }}
                >
                  {feature.i18n.t("actions.clearBrowsingData")}
                </BrowserNodeMenuItem>
              ) : null}
              <BrowserNodeMenuSeparator />
              <BrowserNodeMenuItem
                onClick={() => {
                  dismissMenu();
                  setSettingsOpen(true);
                }}
              >
                {feature.i18n.t("actions.browserSettings")}
              </BrowserNodeMenuItem>
              {onOpenDevTools ? (
                <>
                  <BrowserNodeMenuSeparator />
                  <BrowserNodeMenuItem
                    onClick={() => {
                      dismissMenu();
                      onOpenDevTools();
                    }}
                  >
                    {feature.i18n.t("actions.openDevTools")}
                  </BrowserNodeMenuItem>
                </>
              ) : null}
            </>
          ) : null}
          {menuPanel === "find" ? (
            <>
              <BrowserNodeMenuPanelHeader
                backLabel={feature.i18n.t("actions.back")}
                label={feature.i18n.t("actions.findInPage")}
                onBack={() => setMenuPanel("main")}
              />
              <div
                className="space-y-2 p-2"
                onKeyDown={(event) => event.stopPropagation()}
              >
                <Input
                  autoFocus
                  aria-label={feature.i18n.t("find.placeholder")}
                  placeholder={feature.i18n.t("find.placeholder")}
                  size="sm"
                  value={findText}
                  onChange={(event) => {
                    const text = event.target.value;
                    setFindText(text);
                    runAction(
                      "find-in-page-failed",
                      () =>
                        hostApi.findInPage?.({
                          findNext: false,
                          forward: true,
                          nodeId,
                          text
                        }) ?? Promise.resolve()
                    );
                  }}
                  onKeyDown={(event) => handleFindKeyDown(event, find)}
                />
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--text-secondary)]">
                    {feature.i18n.t("find.results", {
                      current: findResult?.activeMatchOrdinal ?? 0,
                      total: findResult?.matches ?? 0
                    })}
                  </span>
                  <div className="flex items-center gap-1">
                    <Button
                      aria-label={feature.i18n.t("find.previous")}
                      disabled={!findText}
                      size="icon-sm"
                      title={feature.i18n.t("find.previous")}
                      type="button"
                      variant="chrome"
                      onClick={() => find({ findNext: true, forward: false })}
                    >
                      <ChevronUpIcon className="size-3.5" />
                    </Button>
                    <Button
                      aria-label={feature.i18n.t("find.next")}
                      disabled={!findText}
                      size="icon-sm"
                      title={feature.i18n.t("find.next")}
                      type="button"
                      variant="chrome"
                      onClick={() => find({ findNext: true, forward: true })}
                    >
                      <ChevronDownIcon className="size-3.5" />
                    </Button>
                    <Button
                      aria-label={feature.i18n.t("find.close")}
                      size="icon-sm"
                      title={feature.i18n.t("find.close")}
                      type="button"
                      variant="chrome"
                      onClick={() => {
                        stopFind();
                        dismissMenu();
                      }}
                    >
                      <CloseIcon className="size-3.5" />
                    </Button>
                  </div>
                </div>
              </div>
            </>
          ) : null}
          {menuPanel === "device" ? (
            <>
              <BrowserNodeMenuPanelHeader
                backLabel={feature.i18n.t("actions.back")}
                label={feature.i18n.t("actions.deviceEmulation")}
                onBack={() => setMenuPanel("main")}
              />
              {devicePresetOptions.map((option) => (
                <BrowserNodeMenuItem
                  key={option.value}
                  endAdornment={
                    devicePreset === option.value ? <span>✓</span> : null
                  }
                  onClick={() => {
                    setDevicePresetForNode(option.value);
                    dismissMenu();
                  }}
                >
                  {feature.i18n.t(option.i18nKey)}
                </BrowserNodeMenuItem>
              ))}
            </>
          ) : null}
          {menuPanel === "screenshot" ? (
            <>
              <BrowserNodeMenuPanelHeader
                backLabel={feature.i18n.t("actions.back")}
                label={feature.i18n.t("actions.screenshotMode")}
                onBack={() => setMenuPanel("main")}
              />
              {(["visible", "full-page"] as const).map((mode) => (
                <BrowserNodeMenuItem
                  key={mode}
                  endAdornment={screenshotMode === mode ? <span>✓</span> : null}
                  onClick={() => {
                    setScreenshotMode(mode);
                    dismissMenu();
                  }}
                >
                  {feature.i18n.t(
                    mode === "visible"
                      ? "screenshot.visible"
                      : "screenshot.fullPage"
                  )}
                </BrowserNodeMenuItem>
              ))}
            </>
          ) : null}
          {menuPanel === "downloads" ? (
            <>
              <BrowserNodeMenuPanelHeader
                backLabel={feature.i18n.t("actions.back")}
                label={feature.i18n.t("actions.downloads")}
                onBack={() => setMenuPanel("main")}
              />
              <div className="max-h-[360px] overflow-y-auto p-0.5">
                {runtime.downloads.length === 0 ? (
                  <div className="px-3 py-5 text-center text-[12px] text-[var(--text-secondary)]">
                    {feature.i18n.t("downloads.empty")}
                  </div>
                ) : (
                  runtime.downloads.map((download) => (
                    <BrowserDownloadRow
                      download={download}
                      feature={feature}
                      key={download.id}
                      onAction={performDownloadAction}
                    />
                  ))
                )}
              </div>
            </>
          ) : null}
        </MenuSurface>
      ) : null}
      <ConfirmationDialog
        cancelLabel={feature.i18n.t("clearBrowsingData.cancel")}
        confirmBusy={clearBusy}
        confirmLabel={feature.i18n.t("clearBrowsingData.confirm")}
        description={feature.i18n.t("clearBrowsingData.description")}
        open={clearDialogOpen}
        title={feature.i18n.t("clearBrowsingData.title")}
        tone="destructive"
        onOpenChange={setClearDialogOpen}
        onConfirm={() => {
          if (!hostApi.clearBrowsingData) {
            return;
          }
          setClearBusy(true);
          void hostApi
            .clearBrowsingData({ nodeId })
            .then(() => setClearDialogOpen(false))
            .catch((error: unknown) => {
              feature.reportDiagnostic?.({
                details: {
                  error: error instanceof Error ? error.message : String(error),
                  nodeId
                },
                event: "clear-browsing-data-failed",
                level: "warn"
              });
            })
            .finally(() => setClearBusy(false));
        }}
      />
      <BrowserNodeSettingsDialog
        devicePreset={devicePreset}
        downloadDirectory={downloadDirectory}
        feature={feature}
        nodeId={nodeId}
        open={settingsOpen}
        screenshotMode={screenshotMode}
        zoomFactor={runtime.zoomFactor}
        onClearBrowsingData={() => {
          setSettingsOpen(false);
          setClearDialogOpen(true);
        }}
        onDevicePresetChange={setDevicePresetForNode}
        onDownloadDirectoryChange={setDownloadDirectory}
        onOpenChange={setSettingsOpen}
        onScreenshotModeChange={setScreenshotMode}
        onZoomFactorChange={setZoom}
      />
    </>
  );
}

const devicePresetOptions: readonly {
  i18nKey:
    | "device.desktop"
    | "device.ipadAir"
    | "device.iphone14"
    | "device.pixel7";
  value: BrowserNodeDevicePreset;
}[] = [
  { i18nKey: "device.desktop", value: "desktop" },
  { i18nKey: "device.iphone14", value: "iphone-14" },
  { i18nKey: "device.pixel7", value: "pixel-7" },
  { i18nKey: "device.ipadAir", value: "ipad-air" }
];

function BrowserDownloadRow({
  download,
  feature,
  onAction
}: {
  download: BrowserNodeDownloadState;
  feature: BrowserNodeFeature;
  onAction: (downloadId: string, action: BrowserNodeDownloadAction) => void;
}): JSX.Element {
  const percent =
    download.totalBytes > 0
      ? Math.min(100, (download.receivedBytes / download.totalBytes) * 100)
      : 0;
  const isActive =
    download.status === "progressing" || download.status === "paused";

  return (
    <div className="rounded-md px-2 py-2 hover:bg-[var(--transparency-hover)]">
      <div className="flex min-w-0 items-center gap-2">
        <DownloadIcon className="size-4 shrink-0 text-[var(--text-secondary)]" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px] font-medium text-[var(--text-primary)]">
            {download.fileName}
          </div>
          <div className="mt-0.5 text-[11px] text-[var(--text-secondary)]">
            {formatDownloadStatus(feature, download.status)}
            {isActive
              ? ` · ${formatByteSize(download.receivedBytes)} / ${formatByteSize(download.totalBytes)}`
              : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {download.status === "progressing" ? (
            <DownloadActionButton
              label={feature.i18n.t("actions.pauseDownload")}
              onClick={() => onAction(download.id, "pause")}
            >
              <PauseIcon className="size-3.5" />
            </DownloadActionButton>
          ) : null}
          {download.status === "paused" ||
          (download.status === "interrupted" && download.canResume) ? (
            <DownloadActionButton
              label={feature.i18n.t("actions.resumeDownload")}
              onClick={() => onAction(download.id, "resume")}
            >
              <PlayIcon className="size-3.5" />
            </DownloadActionButton>
          ) : null}
          {isActive ? (
            <DownloadActionButton
              label={feature.i18n.t("actions.cancelDownload")}
              onClick={() => onAction(download.id, "cancel")}
            >
              <DeleteIcon className="size-3.5" />
            </DownloadActionButton>
          ) : null}
          {download.status === "completed" ? (
            <>
              <DownloadActionButton
                label={feature.i18n.t("actions.openDownload")}
                onClick={() => onAction(download.id, "open")}
              >
                <LaunchIcon className="size-3.5" />
              </DownloadActionButton>
              <DownloadActionButton
                label={feature.i18n.t("actions.showDownloadInFolder")}
                onClick={() => onAction(download.id, "show-in-folder")}
              >
                <LocateFolderIcon className="size-3.5" />
              </DownloadActionButton>
            </>
          ) : null}
        </div>
      </div>
      {isActive ? (
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-[var(--transparency-block)]">
          <div
            className="h-full rounded-full bg-[var(--status-running)]"
            style={{ width: `${percent}%` }}
          />
        </div>
      ) : null}
    </div>
  );
}

function DownloadActionButton({
  children,
  label,
  onClick
}: {
  children: JSX.Element;
  label: string;
  onClick: () => void;
}): JSX.Element {
  return (
    <Button
      aria-label={label}
      size="icon-sm"
      title={label}
      type="button"
      variant="chrome"
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

function handleFindKeyDown(
  event: KeyboardEvent<HTMLInputElement>,
  find: (input: { findNext: boolean; forward: boolean }) => void
): void {
  if (event.key !== "Enter") {
    return;
  }
  event.preventDefault();
  find({ findNext: true, forward: !event.shiftKey });
}

function formatByteSize(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB"];
  const unitIndex = Math.min(
    units.length - 1,
    Math.floor(Math.log(value) / Math.log(1024))
  );
  const amount = value / 1024 ** unitIndex;
  return `${amount >= 10 || unitIndex === 0 ? Math.round(amount) : amount.toFixed(1)} ${units[unitIndex]}`;
}

function formatDownloadStatus(
  feature: BrowserNodeFeature,
  status: BrowserNodeDownloadState["status"]
): string {
  switch (status) {
    case "cancelled":
      return feature.i18n.t("downloads.status.cancelled");
    case "completed":
      return feature.i18n.t("downloads.status.completed");
    case "interrupted":
      return feature.i18n.t("downloads.status.interrupted");
    case "paused":
      return feature.i18n.t("downloads.status.paused");
    case "progressing":
      return feature.i18n.t("downloads.status.progressing");
  }
}
