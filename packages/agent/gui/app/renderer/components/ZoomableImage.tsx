import {
  cloneElement,
  isValidElement,
  type ComponentPropsWithoutRef,
  type JSX,
  type MouseEvent,
  type ReactElement,
  useCallback,
  useEffect,
  useState
} from "react";
import {
  ToastProvider,
  ToastRoot,
  ToastTitle,
  ToastViewport
} from "@tutti-os/ui-system";
import { CopyIcon, DownloadIcon } from "lucide-react";
import Zoom from "react-medium-image-zoom";
import { useTranslation } from "../../../i18n/index";
import { cn } from "../lib/utils";
import { ConversationImageContextMenu } from "../../../shared/agentConversation/components/ConversationImageContextMenu";
import { copyImageToClipboard } from "../../../shared/agentConversation/lib/copyImageToClipboard";
import { useOptionalAgentHostApi } from "../../../agentActivityHost";

interface ZoomableImageProps extends ComponentPropsWithoutRef<"img"> {
  downloadName?: string;
  wrapElement?: "div" | "span";
}

type ImageCopyStatus = {
  busy: boolean;
  message: string;
  variant: "destructive" | "success";
};

export function ZoomableImage({
  alt,
  className,
  downloadName,
  onContextMenu,
  src,
  wrapElement = "div",
  ...props
}: ZoomableImageProps): JSX.Element {
  const { t } = useTranslation();
  const agentHostApi = useOptionalAgentHostApi();
  const actionSource =
    typeof src === "string" && src.trim() ? src.trim() : null;
  const hasImageActions = Boolean(actionSource && downloadName !== undefined);
  const [contextMenuPosition, setContextMenuPosition] = useState<{
    x: number;
    y: number;
    inZoomDialog: boolean;
  } | null>(null);
  const [copyStatus, setCopyStatus] = useState<ImageCopyStatus | null>(null);

  const closeContextMenu = useCallback(() => {
    setContextMenuPosition(null);
  }, []);

  useEffect(() => {
    if (!contextMenuPosition) {
      return;
    }

    document.addEventListener("click", closeContextMenu);
    document.addEventListener("scroll", closeContextMenu, true);
    return () => {
      document.removeEventListener("click", closeContextMenu);
      document.removeEventListener("scroll", closeContextMenu, true);
    };
  }, [closeContextMenu, contextMenuPosition]);

  useEffect(() => {
    if (!copyStatus || copyStatus.busy) {
      return;
    }
    const timer = setTimeout(() => setCopyStatus(null), 1600);
    return () => clearTimeout(timer);
  }, [copyStatus]);

  const handleContextMenu = useCallback(
    (event: MouseEvent<HTMLImageElement>): void => {
      onContextMenu?.(event);
      if (event.defaultPrevented || !actionSource || !hasImageActions) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setContextMenuPosition({
        x: event.clientX,
        y: event.clientY,
        inZoomDialog: Boolean(event.currentTarget.closest(".tsh-zoom-dialog"))
      });
    },
    [actionSource, hasImageActions, onContextMenu]
  );

  const handleCopyImage = useCallback(async (): Promise<void> => {
    if (!actionSource) {
      return;
    }
    const copyingMessage = t("common.copying");
    setCopyStatus({
      busy: true,
      message: copyingMessage,
      variant: "success"
    });
    closeContextMenu();
    const copied = await Promise.race([
      copyImageToClipboard(actionSource, agentHostApi?.clipboard),
      new Promise<boolean>((resolve) => {
        window.setTimeout(() => resolve(false), 5000);
      })
    ]);
    const message = t(
      copied ? "agentHost.agentGui.messageCopied" : "common.copyFailed"
    );
    setCopyStatus({
      busy: false,
      message,
      variant: copied ? "success" : "destructive"
    });
  }, [actionSource, agentHostApi?.clipboard, closeContextMenu, t]);

  const handleCopyImageAction = useCallback((): void => {
    void handleCopyImage().catch(() => undefined);
  }, [handleCopyImage]);

  const handleDownloadImage = useCallback((): void => {
    if (!actionSource) {
      return;
    }
    closeContextMenu();
    downloadImage(
      actionSource,
      resolveImageDownloadName(downloadName, actionSource, alt)
    );
  }, [actionSource, alt, closeContextMenu, downloadName]);

  const actionButtons = hasImageActions ? (
    <ImageActionButtons
      copyLabel={t("common.copyImage")}
      downloadLabel={t("common.downloadImage")}
      onCopy={handleCopyImageAction}
      onDownload={handleDownloadImage}
    />
  ) : null;

  const renderZoomContent = ({
    buttonUnzoom,
    img
  }: {
    buttonUnzoom: ReactElement<HTMLButtonElement>;
    img: ReactElement | null;
  }): JSX.Element => {
    const zoomSrc =
      isValidElement(img) &&
      typeof (img.props as { src?: unknown }).src === "string"
        ? (img.props as { src: string }).src
        : null;
    return (
      <>
        {actionButtons && img && zoomSrc ? (
          cloneElement(img as ReactElement<ComponentPropsWithoutRef<"img">>, {
            onContextMenu: handleContextMenu
          })
        ) : !actionButtons && img && zoomSrc ? (
          <ConversationImageContextMenu
            src={zoomSrc}
            asChild
            contentStyle={{ zIndex: "var(--z-dialog-popover)" }}
          >
            {img}
          </ConversationImageContextMenu>
        ) : (
          img
        )}
        {actionButtons ? (
          <div className="tsh-zoom-dialog__image-actions nodrag tsh-desktop-no-drag">
            <ImageActionButtons
              copyLabel={t("common.copyImage")}
              downloadLabel={t("common.downloadImage")}
              onCopy={handleCopyImageAction}
              onDownload={handleDownloadImage}
            />
          </div>
        ) : null}
        {contextMenuPosition?.inZoomDialog && actionButtons ? (
          <div
            className="tsh-image-context-menu nodrag tsh-desktop-no-drag"
            style={{
              left: contextMenuPosition.x,
              top: contextMenuPosition.y
            }}
            role="menu"
            onClick={(event) => event.stopPropagation()}
          >
            <ImageActionButtons
              copyLabel={t("common.copyImage")}
              downloadLabel={t("common.downloadImage")}
              itemRole="menuitem"
              onCopy={handleCopyImageAction}
              onDownload={handleDownloadImage}
            />
          </div>
        ) : null}
        {cloneElement(buttonUnzoom, {
          className: cn(
            buttonUnzoom.props.className,
            "nodrag tsh-desktop-no-drag"
          )
        })}
      </>
    );
  };

  return (
    <>
      <Zoom
        a11yNameButtonZoom={t("common.expandImage")}
        a11yNameButtonUnzoom={t("common.minimizeImage")}
        classDialog="tsh-zoom-dialog nodrag tsh-desktop-no-drag"
        wrapElement={wrapElement}
        zoomMargin={24}
        ZoomContent={renderZoomContent}
      >
        <img
          {...props}
          alt={alt}
          src={src}
          onContextMenu={hasImageActions ? handleContextMenu : onContextMenu}
          className={cn("nodrag tsh-desktop-no-drag cursor-zoom-in", className)}
        />
      </Zoom>
      {contextMenuPosition &&
      !contextMenuPosition.inZoomDialog &&
      actionButtons ? (
        <div
          className="tsh-image-context-menu nodrag tsh-desktop-no-drag"
          style={{
            left: contextMenuPosition.x,
            top: contextMenuPosition.y
          }}
          role="menu"
          onClick={(event) => event.stopPropagation()}
        >
          <ImageActionButtons
            copyLabel={t("common.copyImage")}
            downloadLabel={t("common.downloadImage")}
            itemRole="menuitem"
            onCopy={handleCopyImageAction}
            onDownload={handleDownloadImage}
          />
        </div>
      ) : null}
      {copyStatus ? (
        <ImageCopyStatusToast
          busy={copyStatus.busy}
          message={copyStatus.message}
          variant={copyStatus.variant}
          onOpenChange={(open) => {
            if (!open) {
              setCopyStatus(null);
            }
          }}
        />
      ) : null}
    </>
  );
}

function ImageCopyStatusToast({
  busy,
  message,
  onOpenChange,
  variant
}: {
  busy: boolean;
  message: string;
  onOpenChange: (open: boolean) => void;
  variant: ImageCopyStatus["variant"];
}): JSX.Element {
  return (
    <ToastProvider duration={1600} swipeDirection="right">
      <ToastRoot
        open
        anchor="viewport"
        busy={busy}
        variant={variant}
        onOpenChange={onOpenChange}
      >
        <ToastTitle>{message}</ToastTitle>
      </ToastRoot>
      <ToastViewport
        className="nodrag tsh-desktop-no-drag"
        style={{
          top: "max(20px, calc(var(--cove-titlebar-reserve, 0px) + 10px))",
          zIndex: 100303
        }}
      />
    </ToastProvider>
  );
}

function ImageActionButtons({
  copyLabel,
  downloadLabel,
  itemRole,
  onCopy,
  onDownload
}: {
  copyLabel: string;
  downloadLabel: string;
  itemRole?: "menuitem";
  onCopy: () => void;
  onDownload: () => void;
}): JSX.Element {
  return (
    <>
      <button
        type="button"
        role={itemRole}
        title={copyLabel}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onCopy();
        }}
      >
        <CopyIcon aria-hidden="true" className="size-4" />
        <span>{copyLabel}</span>
      </button>
      <button
        type="button"
        role={itemRole}
        title={downloadLabel}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onDownload();
        }}
      >
        <DownloadIcon aria-hidden="true" className="size-4" />
        <span>{downloadLabel}</span>
      </button>
    </>
  );
}

function downloadImage(src: string, name: string): void {
  const link = document.createElement("a");
  link.href = src;
  link.download = name;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
}

function resolveImageDownloadName(
  name: string | undefined,
  src: string | null,
  alt: string | undefined
): string {
  const semanticName =
    resolveImageNameBase(name) ??
    resolveImageNameBase(alt) ??
    resolveImageNameBase(src) ??
    "image";
  const extension =
    resolveImageNameExtension(name) ??
    resolveImageNameExtension(src) ??
    resolveDataImageExtension(src) ??
    "png";
  return `${semanticName}-${formatImageDownloadTimestamp(new Date())}-${createDownloadRandomSuffix()}.${extension}`;
}

function resolveImageNameBase(value: string | null | undefined): string | null {
  const segment = imageNameSegment(value);
  if (!segment) {
    return null;
  }
  const base = segment.replace(/\.[A-Za-z0-9]{2,8}$/u, "");
  const sanitized = stripControlCharacters(base)
    .replace(/[\\/:*?"<>|#%&{}$!'@+`=]+/gu, "-")
    .replace(/\s+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 80);
  return sanitized || null;
}

function stripControlCharacters(value: string): string {
  return Array.from(value)
    .filter((char) => char.charCodeAt(0) >= 32)
    .join("");
}

function resolveImageNameExtension(
  value: string | null | undefined
): string | null {
  const segment = imageNameSegment(value);
  const match = segment?.match(/\.([A-Za-z0-9]{2,8})$/u);
  if (!match?.[1]) {
    return null;
  }
  return normalizeImageExtension(match[1]);
}

function imageNameSegment(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  const withoutQuery = decodeURIComponentSafe(
    trimmed.split(/[?#]/, 1)[0] ?? ""
  );
  return withoutQuery.split(/[\\/]/).pop()?.trim() || null;
}

function resolveDataImageExtension(src: string | null): string | null {
  const match = src?.match(/^data:image\/([A-Za-z0-9.+-]+)[;,]/u);
  return match?.[1] ? normalizeImageExtension(match[1]) : null;
}

function normalizeImageExtension(extension: string): string {
  const normalized = extension.toLowerCase();
  if (normalized === "jpeg") {
    return "jpg";
  }
  if (normalized === "svg+xml") {
    return "svg";
  }
  return normalized.replace(/[^a-z0-9]/gu, "") || "png";
}

function formatImageDownloadTimestamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function createDownloadRandomSuffix(): string {
  return Math.random().toString(36).slice(2, 6).padEnd(4, "0");
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
