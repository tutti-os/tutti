import { useCallback, useEffect, useMemo, useState, type JSX } from "react";
import { LoaderCircle } from "lucide-react";
import { useOptionalAgentGUIRuntime } from "../../../agentActivityRuntime";
import { ZoomableImage } from "../../../app/renderer/components/ZoomableImage";
import styles from "../../../agent-gui/agentGuiNode/AgentGUIConversation.styles";
import type {
  AgentMessageContentVM,
  AgentMessageImageVM
} from "../contracts/agentMessageRowVM";
import type {
  AgentConversationUnavailableImageReason,
  AgentConversationUnavailableImageRenderer
} from "../contracts/agentConversationUnavailableImage";
import { resolveAgentConversationUnavailableImageRenderer } from "./AgentConversationUnavailableImageFallback";

interface AgentMessageImageFailure {
  identity: string;
  reason: AgentConversationUnavailableImageReason;
}

export function AgentUserImageGrid({
  message,
  renderUnavailableImage
}: {
  message: AgentMessageContentVM;
  renderUnavailableImage?: AgentConversationUnavailableImageRenderer;
}): JSX.Element {
  "use memo";
  const images = message.images ?? [];
  const unavailableImageRenderer =
    resolveAgentConversationUnavailableImageRenderer(renderUnavailableImage);
  const { failures, loadingIds, markLoadFailed, sources } =
    useAgentMessageImageSources(images);
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
        const loading = !src && loadingIds.has(image.id);
        const failure = failures.get(image.id);
        const failureReason =
          failure?.identity === imageIdentity(image) ? failure.reason : null;
        const alt = image.name?.trim() || "image";
        const unavailable =
          !loading && (!src || failureReason)
            ? unavailableImageRenderer({
                source: "user-message",
                reason: failureReason ?? "unavailable",
                alt
              })
            : null;
        return (
          <div key={image.id} className={styles.userImageThumbnail}>
            {!loading && (!src || failureReason) ? (
              <>{unavailable}</>
            ) : src ? (
              <ZoomableImage
                src={src}
                alt={alt}
                className="block max-h-20 w-full rounded-[7px] object-contain"
                draggable={false}
                downloadName={image.name?.trim() || "image.png"}
                onError={() => markLoadFailed(image)}
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
              <div className="h-20 w-full animate-pulse bg-[color-mix(in_srgb,var(--text-primary)_8%,transparent)]" />
            )}
          </div>
        );
      })}
    </div>
  );
}

function useAgentMessageImageSources(images: readonly AgentMessageImageVM[]): {
  failures: ReadonlyMap<string, AgentMessageImageFailure>;
  loadingIds: ReadonlySet<string>;
  markLoadFailed: (image: AgentMessageImageVM) => void;
  sources: ReadonlyMap<string, string>;
} {
  const runtime = useOptionalAgentGUIRuntime();
  const [sources, setSources] = useState<Map<string, string>>(() => new Map());
  const [loadingIds, setLoadingIds] = useState<Set<string>>(() => new Set());
  const [failures, setFailures] = useState<
    Map<string, AgentMessageImageFailure>
  >(() => new Map());
  const missingImages = useMemo(
    () =>
      images.filter(
        (image) =>
          !imageSourceUrl(image) &&
          !sources.has(image.id) &&
          failures.get(image.id)?.identity !== imageIdentity(image) &&
          image.workspaceId &&
          image.agentSessionId &&
          (image.attachmentId || image.path)
      ),
    [failures, images, sources]
  );

  const markLoadFailed = useCallback((image: AgentMessageImageVM): void => {
    setFailures((current) => {
      const next = new Map(current);
      next.set(image.id, {
        identity: imageIdentity(image),
        reason: "load-failed"
      });
      return next;
    });
  }, []);

  useEffect(() => {
    if (
      (!runtime?.readSessionAttachment && !runtime?.readPromptAsset) ||
      missingImages.length === 0
    ) {
      return;
    }
    let canceled = false;
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
          setFailures((current) => {
            if (!current.has(image.id)) {
              return current;
            }
            const next = new Map(current);
            next.delete(image.id);
            return next;
          });
        })
        .catch(() => {
          if (canceled) return;
          setFailures((current) => {
            const next = new Map(current);
            next.set(image.id, {
              identity: imageIdentity(image),
              reason: "read-failed"
            });
            return next;
          });
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
    return () => {
      canceled = true;
    };
  }, [missingImages, runtime]);

  return { failures, loadingIds, markLoadFailed, sources };
}

function imageIdentity(image: AgentMessageImageVM): string {
  const data = image.data?.trim() ?? "";
  return [
    image.id,
    image.attachmentId?.trim() ?? "",
    image.path?.trim() ?? "",
    image.url?.trim() ?? "",
    data ? `${data.length}:${data.slice(0, 24)}` : ""
  ].join("\u0000");
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
