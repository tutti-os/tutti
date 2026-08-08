import { Button } from "@tutti-os/ui-system";
import {
  AlertCircle,
  LoaderCircle,
  RotateCcw,
  type LucideIcon
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type JSX } from "react";
import {
  useOptionalAgentGUIRuntime,
  type AgentGUIRuntime
} from "../../../agentActivityRuntime";
import { ZoomableImage } from "../../../app/renderer/components/ZoomableImage";
import { useTranslation } from "../../../i18n/index";
import styles from "../../../agent-gui/agentGuiNode/AgentGUIConversation.styles";
import type {
  AgentMessageContentVM,
  AgentMessageImageVM
} from "../contracts/agentMessageRowVM";

type ImageFailureKind = "load" | "read" | "unavailable";
type ImageFailureReporter = (
  image: AgentMessageImageVM,
  kind: ImageFailureKind,
  attempt: number
) => void;

export function AgentUserImageGrid({
  message
}: {
  message: AgentMessageContentVM;
}): JSX.Element {
  "use memo";
  const images = message.images ?? [];
  const runtime = useOptionalAgentGUIRuntime();
  const reportFailure = useCallback(
    (image: AgentMessageImageVM, kind: ImageFailureKind, attempt: number) => {
      reportImageLoadFailure(runtime, image, kind, attempt);
    },
    [runtime]
  );
  const { failedIds, loadingIds, retryCounts, sources, markFailed, retry } =
    useAgentMessageImageSources(images, reportFailure);
  const { t } = useTranslation();
  const columnCount = Math.min(Math.max(images.length, 1), 4);
  const thumbnailWidth = images.length === 1 ? "160px" : "80px";
  return (
    <div
      className={styles.userImageGrid}
      style={{
        gridTemplateColumns: `repeat(${columnCount}, ${thumbnailWidth})`
      }}
    >
      {images.map((image) => {
        const src = sources.get(image.id) ?? imageSourceUrl(image);
        const failed = failedIds.has(image.id);
        const loading = !src && loadingIds.has(image.id);
        const attempt = retryCounts.get(image.id) ?? 0;
        return (
          <div key={image.id} className={styles.userImageThumbnail}>
            {failed ? (
              <ImageLoadFailurePlaceholder
                label={t("agentHost.agentGui.imageLoadFailed")}
                retryLabel={t("agentHost.agentGui.retryImage")}
                icon={AlertCircle}
                onRetry={() => retry(image.id)}
              />
            ) : src ? (
              <ZoomableImage
                key={`${image.id}:${attempt}:${src}`}
                src={src}
                alt={image.name?.trim() || "image"}
                className="block max-h-20 w-full rounded-[7px] object-contain"
                draggable={false}
                downloadName={image.name?.trim() || "image.png"}
                onError={() => {
                  markFailed(image.id);
                  reportFailure(image, "load", attempt);
                }}
              />
            ) : loading ? (
              <div
                className="flex h-20 w-full items-center justify-center bg-[color-mix(in_srgb,var(--text-primary)_6%,transparent)]"
                data-testid="agent-gui-message-image-loading"
              >
                <LoaderCircle
                  aria-hidden="true"
                  className="size-5 animate-spin text-[color-mix(in_srgb,var(--text-primary)_45%,transparent)]"
                  strokeWidth={2}
                />
              </div>
            ) : (
              <ImageLoadFailurePlaceholder
                label={t("agentHost.agentGui.imageLoadFailed")}
                retryLabel={t("agentHost.agentGui.retryImage")}
                icon={AlertCircle}
                onRetry={() => retry(image.id)}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

function useAgentMessageImageSources(
  images: readonly AgentMessageImageVM[],
  reportFailure: ImageFailureReporter
): {
  failedIds: ReadonlySet<string>;
  loadingIds: ReadonlySet<string>;
  retryCounts: ReadonlyMap<string, number>;
  sources: ReadonlyMap<string, string>;
  markFailed: (imageId: string) => void;
  retry: (imageId: string) => void;
} {
  const runtime = useOptionalAgentGUIRuntime();
  const [failedIds, setFailedIds] = useState<Set<string>>(() => new Set());
  const [sources, setSources] = useState<Map<string, string>>(() => new Map());
  const [loadingIds, setLoadingIds] = useState<Set<string>>(() => new Set());
  const [retryCounts, setRetryCounts] = useState<Map<string, number>>(
    () => new Map()
  );
  const markFailed = useCallback((imageId: string): void => {
    setFailedIds((current) => {
      if (current.has(imageId)) return current;
      const next = new Set(current);
      next.add(imageId);
      return next;
    });
    setLoadingIds((current) => {
      if (!current.has(imageId)) return current;
      const next = new Set(current);
      next.delete(imageId);
      return next;
    });
  }, []);
  const retry = useCallback((imageId: string): void => {
    setFailedIds((current) => {
      if (!current.has(imageId)) return current;
      const next = new Set(current);
      next.delete(imageId);
      return next;
    });
    setRetryCounts((current) => {
      const next = new Map(current);
      next.set(imageId, (next.get(imageId) ?? 0) + 1);
      return next;
    });
  }, []);
  const missingImages = useMemo(
    () =>
      images.filter(
        (image) =>
          !imageSourceUrl(image) &&
          !sources.has(image.id) &&
          !failedIds.has(image.id) &&
          image.workspaceId &&
          image.agentSessionId &&
          (image.attachmentId
            ? runtime?.readSessionAttachment
            : runtime?.readPromptAsset) &&
          (image.attachmentId || image.path)
      ),
    [failedIds, images, runtime, sources]
  );
  const unavailableImages = useMemo(
    () =>
      images.filter(
        (image) =>
          !imageSourceUrl(image) &&
          !sources.has(image.id) &&
          !failedIds.has(image.id) &&
          (!image.workspaceId ||
            !image.agentSessionId ||
            !(image.attachmentId || image.path) ||
            (image.attachmentId
              ? !runtime?.readSessionAttachment
              : !runtime?.readPromptAsset))
      ),
    [failedIds, images, runtime, sources]
  );

  useEffect(() => {
    let canceled = false;
    if (
      runtime &&
      (runtime.readSessionAttachment || runtime.readPromptAsset) &&
      missingImages.length > 0
    ) {
      for (const image of missingImages) {
        const readImage = image.attachmentId
          ? runtime.readSessionAttachment?.({
              workspaceId: image.workspaceId ?? "",
              agentSessionId: image.agentSessionId,
              attachmentId: image.attachmentId ?? ""
            })
          : runtime.readPromptAsset?.({
              workspaceId: image.workspaceId ?? "",
              agentSessionId: image.agentSessionId,
              mimeType: image.mimeType,
              name: image.name,
              path: image.path
            });
        if (!readImage) continue;
        setLoadingIds((current) => new Set(current).add(image.id));
        const attempt = retryCounts.get(image.id) ?? 0;
        void readImage
          .then((attachment) => {
            if (canceled) return;
            setSources((current) => {
              const next = new Map(current);
              next.set(
                image.id,
                `data:${attachment.mimeType};base64,${attachment.data}`
              );
              return next;
            });
          })
          .catch(() => {
            if (canceled) return;
            markFailed(image.id);
            reportFailure(image, "read", attempt);
          })
          .finally(() => {
            if (canceled) return;
            setLoadingIds((current) => {
              const next = new Set(current);
              next.delete(image.id);
              return next;
            });
          });
      }
    }
    for (const image of unavailableImages) {
      const attempt = retryCounts.get(image.id) ?? 0;
      markFailed(image.id);
      reportFailure(image, "unavailable", attempt);
    }
    return () => {
      canceled = true;
    };
  }, [
    markFailed,
    missingImages,
    reportFailure,
    retryCounts,
    runtime,
    unavailableImages
  ]);

  return {
    failedIds,
    loadingIds,
    retryCounts,
    sources,
    markFailed,
    retry
  };
}

function ImageLoadFailurePlaceholder({
  icon: Icon,
  label,
  onRetry,
  retryLabel
}: {
  icon: LucideIcon;
  label: string;
  onRetry: () => void;
  retryLabel: string;
}): JSX.Element {
  return (
    <div
      className="flex h-20 w-full flex-col items-center justify-center gap-1 bg-[var(--transparency-block)] px-1 text-[var(--text-secondary)]"
      data-testid="agent-gui-message-image-failed"
      role="status"
      aria-label={label}
    >
      <Icon aria-hidden="true" className="size-4" />
      <span className="max-w-full truncate text-xs" title={label}>
        {label}
      </span>
      <Button type="button" variant="ghost" size="xs" onClick={onRetry}>
        <RotateCcw aria-hidden="true" />
        {retryLabel}
      </Button>
    </div>
  );
}

function reportImageLoadFailure(
  runtime: AgentGUIRuntime | null,
  image: AgentMessageImageVM,
  kind: ImageFailureKind,
  attempt: number
): void {
  const reportDiagnostic = runtime?.reportDiagnostic;
  if (!reportDiagnostic) return;
  try {
    void Promise.resolve(
      reportDiagnostic.call(runtime, {
        event: "agent.gui.conversation.image_load_failed",
        level: "warn",
        source: "agent-gui",
        workspaceId: image.workspaceId ?? null,
        details: {
          imageId: image.id,
          attempt,
          failureKind: kind,
          hasUrl: Boolean(image.url?.trim()),
          hasData: Boolean(image.data?.trim()),
          hasAttachmentId: Boolean(image.attachmentId?.trim()),
          hasPath: Boolean(image.path?.trim())
        }
      })
    ).catch((error: unknown) => {
      reportImageLoadDiagnosticFailure(image, error);
    });
  } catch (error) {
    reportImageLoadDiagnosticFailure(image, error);
  }
}

function reportImageLoadDiagnosticFailure(
  image: AgentMessageImageVM,
  error: unknown
): void {
  console.warn(
    "[agent-gui]",
    JSON.stringify({
      event: "agent.gui.conversation.image_diagnostic_failed",
      level: "warn",
      source: "agent-gui",
      workspaceId: image.workspaceId ?? null,
      details: {
        diagnosticEvent: "agent.gui.conversation.image_load_failed",
        error: error instanceof Error ? error.message : String(error)
      }
    })
  );
}

function imageDataUrl(image: AgentMessageImageVM): string | null {
  const data = image.data?.trim() ?? "";
  const mimeType = image.mimeType.trim();
  if (!data || !mimeType) return null;
  return data.startsWith("data:") ? data : `data:${mimeType};base64,${data}`;
}

function imageSourceUrl(image: AgentMessageImageVM): string | null {
  const url = image.url?.trim() ?? "";
  return url || imageDataUrl(image);
}
