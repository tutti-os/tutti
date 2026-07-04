import {
  cloneElement,
  isValidElement,
  type CSSProperties,
  type ComponentPropsWithoutRef,
  type JSX,
  type MouseEvent,
  type ReactElement,
  type WheelEvent,
  useCallback,
  useEffect,
  useState
} from "react";
import { createPortal } from "react-dom";
import {
  Button,
  ToastProvider,
  ToastRoot,
  ToastTitle,
  ToastViewport,
  CopyIcon,
  DownloadIcon,
  RestoreIcon
} from "@tutti-os/ui-system";
import { RotateCcwIcon, ZoomInIcon, ZoomOutIcon } from "lucide-react";
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

const IMAGE_PREVIEW_ZOOM_MIN = 0.5;
const IMAGE_PREVIEW_ZOOM_MAX = 3;
const IMAGE_PREVIEW_ZOOM_STEP = 0.25;

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
  const [imagePreviewZoom, setImagePreviewZoom] = useState(1);
  const [isWheelZooming, setIsWheelZooming] = useState(false);
  const [isImagePreviewOpen, setIsImagePreviewOpen] = useState(false);
  const imagePreviewZoomPercent = Math.round(imagePreviewZoom * 100);
  const canZoomOut = imagePreviewZoom > IMAGE_PREVIEW_ZOOM_MIN;
  const canZoomIn = imagePreviewZoom < IMAGE_PREVIEW_ZOOM_MAX;

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
  const zoomOutPreviewImage = useCallback((): void => {
    setIsWheelZooming(false);
    setImagePreviewZoom((value) =>
      clampSteppedImagePreviewZoom(value - IMAGE_PREVIEW_ZOOM_STEP)
    );
  }, []);
  const zoomInPreviewImage = useCallback((): void => {
    setIsWheelZooming(false);
    setImagePreviewZoom((value) =>
      clampSteppedImagePreviewZoom(value + IMAGE_PREVIEW_ZOOM_STEP)
    );
  }, []);
  const resetPreviewImageZoom = useCallback((): void => {
    setIsWheelZooming(false);
    setImagePreviewZoom(1);
  }, []);
  const handlePreviewImageWheel = useCallback(
    (event: WheelEvent<HTMLElement>): void => {
      event.preventDefault();
      event.stopPropagation();
      if (event.deltaY === 0) {
        return;
      }
      setIsWheelZooming(true);
      setImagePreviewZoom((value) =>
        clampImagePreviewZoom(value * Math.pow(2, resolveWheelZoomDelta(event)))
      );
    },
    []
  );

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
    img,
    modalState
  }: {
    buttonUnzoom: ReactElement<HTMLButtonElement>;
    img: ReactElement | null;
    modalState?: "LOADED" | "LOADING" | "UNLOADED" | "UNLOADING";
  }): JSX.Element => {
    const typedButtonUnzoom = buttonUnzoom as unknown as ReactElement<
      ComponentPropsWithoutRef<"button">
    >;
    const buttonUnzoomProps =
      typedButtonUnzoom.props as ComponentPropsWithoutRef<"button">;
    const zoomSrc =
      isValidElement(img) &&
      typeof (img.props as { src?: unknown }).src === "string"
        ? (img.props as { src: string }).src
        : null;
    const isUnzooming = modalState === "UNLOADING";
    const effectiveImagePreviewZoom = isUnzooming ? 1 : imagePreviewZoom;
    const renderedImage = img
      ? cloneImageWithPreviewZoom(
          img,
          effectiveImagePreviewZoom,
          isUnzooming ? false : isWheelZooming,
          handlePreviewImageWheel
        )
      : null;
    return (
      <>
        {actionButtons && renderedImage && zoomSrc ? (
          cloneElement(
            renderedImage as ReactElement<ComponentPropsWithoutRef<"img">>,
            {
              onContextMenu: handleContextMenu
            }
          )
        ) : !actionButtons && renderedImage && zoomSrc ? (
          <ConversationImageContextMenu
            src={zoomSrc}
            asChild
            contentStyle={{ zIndex: "var(--z-dialog-popover)" }}
          >
            {renderedImage}
          </ConversationImageContextMenu>
        ) : (
          renderedImage
        )}
        <ImagePreviewZoomControls
          canZoomIn={canZoomIn}
          canZoomOut={canZoomOut}
          percent={imagePreviewZoomPercent}
          percentLabel={t("common.imageZoomPercent", {
            percent: imagePreviewZoomPercent
          })}
          reportPercentStatus={!copyStatus}
          resetLabel={t("common.resetImageZoom")}
          zoomInLabel={t("common.zoomInImage")}
          zoomOutLabel={t("common.zoomOutImage")}
          onReset={resetPreviewImageZoom}
          onZoomIn={zoomInPreviewImage}
          onZoomOut={zoomOutPreviewImage}
          onWheel={handlePreviewImageWheel}
        />
        {actionButtons ? (
          <div className="tsh-zoom-dialog__image-actions nodrag tsh-desktop-no-drag">
            {actionButtons}
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
        <Button
          asChild
          className="tsh-zoom-dialog__icon-button nodrag tsh-desktop-no-drag"
          size="icon"
          variant="chrome"
        >
          {cloneElement(
            typedButtonUnzoom,
            {
              onClick: (event: MouseEvent<HTMLButtonElement>) => {
                setIsWheelZooming(false);
                setImagePreviewZoom(1);
                buttonUnzoomProps.onClick?.(event);
              }
            },
            <RestoreIcon aria-hidden="true" className="size-4" />
          )}
        </Button>
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
        onZoomChange={(zoomed) => {
          setIsImagePreviewOpen(zoomed);
          if (!zoomed) {
            setIsWheelZooming(false);
            setImagePreviewZoom(1);
          }
        }}
      >
        <img
          {...props}
          alt={alt}
          src={src}
          onContextMenu={hasImageActions ? handleContextMenu : onContextMenu}
          className={cn("nodrag tsh-desktop-no-drag cursor-zoom-in", className)}
        />
      </Zoom>
      {contextMenuPosition && !contextMenuPosition.inZoomDialog && actionButtons
        ? createPortal(
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
            </div>,
            document.body
          )
        : null}
      {copyStatus && !isImagePreviewOpen
        ? createPortal(
            <ImageCopyStatusToast
              busy={copyStatus.busy}
              message={copyStatus.message}
              variant={copyStatus.variant}
              onOpenChange={(open) => {
                if (!open) {
                  setCopyStatus(null);
                }
              }}
            />,
            document.body
          )
        : null}
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
        data-tsh-image-copy-status="true"
        style={{ zIndex: 100303 }}
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

function ImagePreviewZoomControls({
  canZoomIn,
  canZoomOut,
  percent,
  percentLabel,
  reportPercentStatus,
  resetLabel,
  zoomInLabel,
  zoomOutLabel,
  onReset,
  onZoomIn,
  onZoomOut,
  onWheel
}: {
  canZoomIn: boolean;
  canZoomOut: boolean;
  percent: number;
  percentLabel: string;
  reportPercentStatus: boolean;
  resetLabel: string;
  zoomInLabel: string;
  zoomOutLabel: string;
  onReset: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onWheel: (event: WheelEvent<HTMLElement>) => void;
}): JSX.Element {
  return (
    <div
      className="tsh-zoom-dialog__zoom-controls nodrag tsh-desktop-no-drag"
      onWheel={onWheel}
    >
      <button
        type="button"
        title={zoomOutLabel}
        aria-label={zoomOutLabel}
        disabled={!canZoomOut}
        onClick={onZoomOut}
      >
        <ZoomOutIcon aria-hidden="true" className="size-4" />
      </button>
      <span
        aria-label={percentLabel}
        role={reportPercentStatus ? "status" : undefined}
      >
        {percent}%
      </span>
      <button
        type="button"
        title={resetLabel}
        aria-label={resetLabel}
        onClick={onReset}
      >
        <RotateCcwIcon aria-hidden="true" className="size-4" />
      </button>
      <button
        type="button"
        title={zoomInLabel}
        aria-label={zoomInLabel}
        disabled={!canZoomIn}
        onClick={onZoomIn}
      >
        <ZoomInIcon aria-hidden="true" className="size-4" />
      </button>
    </div>
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
  if (!itemRole) {
    return (
      <>
        <Button
          aria-label={copyLabel}
          className="tsh-zoom-dialog__icon-button"
          size="icon"
          title={copyLabel}
          onPointerDown={(event) => event.stopPropagation()}
          variant="chrome"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onCopy();
          }}
        >
          <CopyIcon aria-hidden="true" className="size-4" />
        </Button>
        <Button
          aria-label={downloadLabel}
          className="tsh-zoom-dialog__icon-button"
          size="icon"
          title={downloadLabel}
          onPointerDown={(event) => event.stopPropagation()}
          variant="chrome"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onDownload();
          }}
        >
          <DownloadIcon aria-hidden="true" className="size-4" />
        </Button>
      </>
    );
  }

  return (
    <>
      <button
        type="button"
        role={itemRole}
        title={copyLabel}
        onPointerDown={(event) => event.stopPropagation()}
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
        onPointerDown={(event) => event.stopPropagation()}
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

function cloneImageWithPreviewZoom(
  img: ReactElement,
  zoom: number,
  isWheelZooming: boolean,
  onWheel: (event: WheelEvent<HTMLElement>) => void
): ReactElement {
  const props = img.props as {
    height?: unknown;
    onWheel?: (event: WheelEvent<HTMLElement>) => void;
    style?: CSSProperties;
    width?: unknown;
  };
  const style = props.style;
  const mergedStyle: CSSProperties = {
    ...style,
    transform: resolveZoomedImageTransform(
      style?.transform,
      zoom,
      resolveImagePreviewDimension(style?.width ?? props.width),
      resolveImagePreviewDimension(style?.height ?? props.height)
    ),
    transition: isWheelZooming
      ? "none"
      : mergeImagePreviewTransition(style?.transition)
  };
  if (style?.transformOrigin !== undefined) {
    mergedStyle.transformOrigin = style.transformOrigin;
  }
  return cloneElement(img, {
    "data-tsh-image-zoom": formatImagePreviewZoom(zoom),
    onWheel: (event: WheelEvent<HTMLElement>) => {
      props.onWheel?.(event);
      onWheel(event);
    },
    style: mergedStyle
  } as Partial<typeof img.props>);
}

function resolveWheelZoomDelta(event: WheelEvent<HTMLElement>): number {
  return (
    -event.deltaY *
    (event.deltaMode === 1 ? 0.05 : event.deltaMode ? 1 : 0.002) *
    (event.ctrlKey ? 10 : 1)
  );
}

function resolveZoomedImageTransform(
  transform: CSSProperties["transform"],
  zoom: number,
  width: number | null,
  height: number | null
): CSSProperties["transform"] {
  const baseTransform = typeof transform === "string" ? transform.trim() : "";
  const zoomTransform = resolveImagePreviewZoomTransform(zoom, width, height);
  if (!baseTransform) {
    return zoomTransform || undefined;
  }
  if (!zoomTransform) {
    return baseTransform;
  }
  return `${baseTransform} ${zoomTransform}`;
}

function resolveImagePreviewZoomTransform(
  zoom: number,
  width: number | null,
  height: number | null
): string {
  if (zoom === 1) {
    return "";
  }

  const scale = `scale(${formatImagePreviewZoom(zoom)})`;
  if (width === null || height === null) {
    return scale;
  }

  const halfWidth = formatCssNumber(width / 2);
  const halfHeight = formatCssNumber(height / 2);
  return `translate(${halfWidth}px,${halfHeight}px) ${scale} translate(-${halfWidth}px,-${halfHeight}px)`;
}

function resolveImagePreviewDimension(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  if (typeof value !== "string") {
    return null;
  }
  const dimension = Number.parseFloat(value);
  return Number.isFinite(dimension) && dimension > 0 ? dimension : null;
}

function formatCssNumber(value: number): string {
  return Number(value.toFixed(3)).toString();
}

function mergeImagePreviewTransition(
  transition: CSSProperties["transition"]
): CSSProperties["transition"] {
  const zoomTransition = "transform 120ms ease-out";
  if (typeof transition !== "string" || !transition.trim()) {
    return zoomTransition;
  }
  return transition.includes("transform")
    ? transition
    : `${transition}, ${zoomTransition}`;
}

function clampSteppedImagePreviewZoom(value: number): number {
  const stepped =
    Math.round(value / IMAGE_PREVIEW_ZOOM_STEP) * IMAGE_PREVIEW_ZOOM_STEP;
  return clampImagePreviewZoom(stepped);
}

function clampImagePreviewZoom(value: number): number {
  return Math.min(
    IMAGE_PREVIEW_ZOOM_MAX,
    Math.max(IMAGE_PREVIEW_ZOOM_MIN, value)
  );
}

function formatImagePreviewZoom(value: number): string {
  return Number(value.toFixed(2)).toString();
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
