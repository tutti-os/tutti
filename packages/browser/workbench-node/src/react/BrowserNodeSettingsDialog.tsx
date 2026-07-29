import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@tutti-os/ui-system";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { JSX } from "react";
import type { BrowserNodeFeature } from "../core/feature.ts";
import type {
  BrowserNodeCookieImportResult,
  BrowserNodeDevicePreset,
  BrowserNodeScreenshotMode
} from "../core/types.ts";
import { BrowserNodeChromeImportDialog } from "./BrowserNodeChromeImportDialog.tsx";
import { browserNodeCookieImportFeedback } from "./chromeCookieImportUiModel.ts";

interface BrowserNodeSettingsDialogProps {
  allowChromeCookieImport: boolean;
  devicePreset: BrowserNodeDevicePreset;
  downloadDirectory: string | null;
  feature: BrowserNodeFeature;
  nodeId: string;
  open: boolean;
  screenshotMode: BrowserNodeScreenshotMode;
  zoomFactor: number;
  onClearBrowsingData: () => void;
  onDevicePresetChange: (preset: BrowserNodeDevicePreset) => void;
  onDownloadDirectoryChange: (path: string) => void;
  onOpenChange: (open: boolean) => void;
  onScreenshotModeChange: (mode: BrowserNodeScreenshotMode) => void;
  onZoomFactorChange: (zoomFactor: number) => void;
}

export function BrowserNodeSettingsDialog({
  allowChromeCookieImport,
  devicePreset,
  downloadDirectory,
  feature,
  nodeId,
  open,
  screenshotMode,
  zoomFactor,
  onClearBrowsingData,
  onDevicePresetChange,
  onDownloadDirectoryChange,
  onOpenChange,
  onScreenshotModeChange,
  onZoomFactorChange
}: BrowserNodeSettingsDialogProps): JSX.Element {
  const [cookieBusy, setCookieBusy] = useState(false);
  const [cookieStatus, setCookieStatus] = useState<string | null>(null);
  const [chromeDialogOpen, setChromeDialogOpen] = useState(false);
  const [directoryBusy, setDirectoryBusy] = useState(false);
  const hostApi = feature.hostApi;
  const chromeImport = feature.chromeCookieImport;
  const chromeState = useSyncExternalStore(
    chromeImport?.subscribe ?? emptySubscribe,
    chromeImport?.getSnapshot ?? idleChromeSnapshot,
    idleChromeSnapshot
  );

  useEffect(() => {
    if (
      open &&
      allowChromeCookieImport &&
      chromeImport &&
      chromeState.status === "idle"
    ) {
      void chromeImport.discover();
    }
  }, [allowChromeCookieImport, chromeImport, chromeState.status, open]);

  const showCookieResult = (result: BrowserNodeCookieImportResult): void => {
    const feedback = browserNodeCookieImportFeedback(feature, result);
    if (feedback) {
      setCookieStatus(feedback.message);
    }
  };

  const importCookies = (): void => {
    if (!hostApi.importCookies) {
      return;
    }
    setCookieBusy(true);
    setCookieStatus(null);
    void hostApi
      .importCookies({ nodeId })
      .then(showCookieResult)
      .catch((error: unknown) => {
        setCookieStatus(feature.i18n.t("settings.importFailed"));
        reportSettingsFailure(feature, nodeId, "import-cookies-failed", error);
      })
      .finally(() => setCookieBusy(false));
  };

  const chooseDownloadDirectory = (): void => {
    if (!hostApi.chooseDownloadDirectory) {
      return;
    }
    setDirectoryBusy(true);
    void hostApi
      .chooseDownloadDirectory({ nodeId })
      .then((result) => {
        if (!result.canceled && result.directoryPath) {
          onDownloadDirectoryChange(result.directoryPath);
        }
      })
      .catch((error: unknown) => {
        reportSettingsFailure(
          feature,
          nodeId,
          "choose-download-directory-failed",
          error
        );
      })
      .finally(() => setDirectoryBusy(false));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>{feature.i18n.t("settings.title")}</DialogTitle>
          <DialogDescription>
            {feature.i18n.t("settings.description")}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-1">
          <SettingsRow label={feature.i18n.t("settings.deviceLabel")}>
            <Select
              value={devicePreset}
              onValueChange={(value) =>
                onDevicePresetChange(value as BrowserNodeDevicePreset)
              }
            >
              <SelectTrigger className="w-48" size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent style={{ zIndex: "var(--z-dialog-popover)" }}>
                <SelectItem value="desktop">
                  {feature.i18n.t("device.desktop")}
                </SelectItem>
                <SelectItem value="iphone-14">
                  {feature.i18n.t("device.iphone14")}
                </SelectItem>
                <SelectItem value="pixel-7">
                  {feature.i18n.t("device.pixel7")}
                </SelectItem>
                <SelectItem value="ipad-air">
                  {feature.i18n.t("device.ipadAir")}
                </SelectItem>
              </SelectContent>
            </Select>
          </SettingsRow>
          <SettingsRow label={feature.i18n.t("settings.zoomLabel")}>
            <div className="flex items-center gap-1">
              <Button
                disabled={zoomFactor <= 0.25}
                size="icon-sm"
                type="button"
                variant="chrome"
                onClick={() => onZoomFactorChange(zoomFactor - 0.1)}
              >
                −
              </Button>
              <Button
                className="min-w-16"
                size="sm"
                type="button"
                variant="chrome"
                onClick={() => onZoomFactorChange(1)}
              >
                {Math.round(zoomFactor * 100)}%
              </Button>
              <Button
                disabled={zoomFactor >= 5}
                size="icon-sm"
                type="button"
                variant="chrome"
                onClick={() => onZoomFactorChange(zoomFactor + 0.1)}
              >
                +
              </Button>
            </div>
          </SettingsRow>
          <SettingsRow label={feature.i18n.t("settings.screenshotLabel")}>
            <Select
              value={screenshotMode}
              onValueChange={(value) =>
                onScreenshotModeChange(value as BrowserNodeScreenshotMode)
              }
            >
              <SelectTrigger className="w-48" size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent style={{ zIndex: "var(--z-dialog-popover)" }}>
                <SelectItem value="visible">
                  {feature.i18n.t("screenshot.visible")}
                </SelectItem>
                <SelectItem value="full-page">
                  {feature.i18n.t("screenshot.fullPage")}
                </SelectItem>
              </SelectContent>
            </Select>
          </SettingsRow>
          {hostApi.chooseDownloadDirectory ? (
            <SettingsSection
              description={
                downloadDirectory ??
                feature.i18n.t("settings.downloadDirectory")
              }
              label={feature.i18n.t("settings.downloadLabel")}
            >
              <Button
                disabled={directoryBusy}
                size="sm"
                type="button"
                variant="outline"
                onClick={chooseDownloadDirectory}
              >
                {feature.i18n.t("settings.chooseDirectory")}
              </Button>
            </SettingsSection>
          ) : null}
          {hostApi.importCookies ? (
            <SettingsSection
              description={
                cookieStatus ?? feature.i18n.t("settings.cookiesDescription")
              }
              label={feature.i18n.t("settings.cookiesLabel")}
            >
              <div className="flex shrink-0 flex-col items-end gap-2">
                {allowChromeCookieImport &&
                chromeState.status === "available" &&
                chromeState.profiles.length > 0 ? (
                  <Button
                    disabled={cookieBusy}
                    size="sm"
                    type="button"
                    onClick={() => setChromeDialogOpen(true)}
                  >
                    {feature.i18n.t("chromeImport.fromChrome")}
                  </Button>
                ) : null}
                <Button
                  disabled={cookieBusy}
                  size="sm"
                  type="button"
                  variant="outline"
                  onClick={importCookies}
                >
                  {cookieBusy
                    ? feature.i18n.t("settings.importingCookies")
                    : feature.i18n.t("settings.importCookies")}
                </Button>
              </div>
            </SettingsSection>
          ) : null}
          {hostApi.clearBrowsingData ? (
            <SettingsSection
              description={feature.i18n.t("settings.dataDescription")}
              label={feature.i18n.t("settings.dataLabel")}
            >
              <Button
                size="sm"
                type="button"
                variant="destructive"
                onClick={onClearBrowsingData}
              >
                {feature.i18n.t("actions.clearBrowsingData")}
              </Button>
            </SettingsSection>
          ) : null}
        </div>
        <DialogFooter>
          <Button
            size="dialog"
            type="button"
            onClick={() => onOpenChange(false)}
          >
            {feature.i18n.t("settings.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
      {allowChromeCookieImport && chromeState.status === "available" ? (
        <BrowserNodeChromeImportDialog
          feature={feature}
          nodeId={nodeId}
          open={chromeDialogOpen}
          profiles={chromeState.profiles}
          onOpenChange={setChromeDialogOpen}
          onResult={showCookieResult}
        />
      ) : null}
    </Dialog>
  );
}

function SettingsRow({
  children,
  label
}: {
  children: JSX.Element;
  label: string;
}): JSX.Element {
  return (
    <div className="flex min-h-9 items-center justify-between gap-4">
      <span className="text-[13px] font-medium text-[var(--text-primary)]">
        {label}
      </span>
      {children}
    </div>
  );
}

function SettingsSection({
  children,
  description,
  label
}: {
  children: JSX.Element;
  description: string;
  label: string;
}): JSX.Element {
  return (
    <div className="flex items-start justify-between gap-4 border-t border-[var(--border-1)] pt-4">
      <div className="min-w-0">
        <div className="text-[13px] font-medium text-[var(--text-primary)]">
          {label}
        </div>
        <div className="mt-0.5 break-all text-[11px] text-[var(--text-secondary)]">
          {description}
        </div>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function reportSettingsFailure(
  feature: BrowserNodeFeature,
  nodeId: string,
  event: string,
  _error: unknown
): void {
  feature.reportDiagnostic?.({
    details: { nodeId },
    event,
    level: "warn"
  });
}

const idleChromeState = { status: "idle" } as const;
function idleChromeSnapshot(): typeof idleChromeState {
  return idleChromeState;
}
function emptySubscribe(): () => void {
  return () => undefined;
}
