import { useEffect, useState, type JSX } from "react";
import { resolveWorkspaceImageMimeType } from "@tutti-os/workspace-file-preview";
import { useOptionalAgentHostApi } from "../../../agentActivityHost";
import { ZoomableImage } from "../../../app/renderer/components/ZoomableImage";
import {
  isLocalImagePath,
  resolveImageGenerationPreviewSrc
} from "../../imageGenerationTool";
import type {
  AgentConversationUnavailableImageReason,
  AgentConversationUnavailableImageRenderer
} from "../contracts/agentConversationUnavailableImage";
import { resolveAgentConversationUnavailableImageRenderer } from "./AgentConversationUnavailableImageFallback";

type AgentGeneratedImagePreviewState =
  | { status: "loading" }
  | { status: "ready"; src: string }
  | {
      status: "error";
      reason: AgentConversationUnavailableImageReason;
    };

interface AgentGeneratedImagePreviewProps {
  uri: string;
  mimeType: string | null;
  alt: string;
  className: string;
  renderUnavailableImage?: AgentConversationUnavailableImageRenderer;
}

export function AgentGeneratedImagePreview({
  uri,
  mimeType,
  alt,
  className,
  renderUnavailableImage
}: AgentGeneratedImagePreviewProps): JSX.Element | null {
  "use memo";
  const unavailableImageRenderer =
    resolveAgentConversationUnavailableImageRenderer(renderUnavailableImage);
  const agentHostApi = useOptionalAgentHostApi();
  const localPath = isLocalImagePath(uri) ? uri.trim() : null;
  const readWorkspaceImage = localPath
    ? agentHostApi?.workspace?.readFile
    : undefined;
  const [state, setState] = useState<AgentGeneratedImagePreviewState>(() => {
    const src = resolveImageGenerationPreviewSrc(uri);
    if (localPath && readWorkspaceImage) {
      return { status: "loading" };
    }
    if (src) {
      return { status: "ready", src };
    }
    return { status: "error", reason: "unavailable" };
  });

  useEffect(() => {
    if (!localPath || !readWorkspaceImage) {
      const src = resolveImageGenerationPreviewSrc(uri);
      setState(
        src
          ? { status: "ready", src }
          : { status: "error", reason: "unavailable" }
      );
      return;
    }

    const resolvedLocalPath = localPath;
    const resolvedReadWorkspaceImage = readWorkspaceImage;
    let canceled = false;
    let objectUrl: string | null = null;
    const resolvedMimeType =
      mimeType?.trim() ||
      resolveWorkspaceImageMimeType(resolvedLocalPath) ||
      "image/png";

    async function loadWorkspaceImage(): Promise<void> {
      try {
        const result = await resolvedReadWorkspaceImage({
          path: resolvedLocalPath
        });
        if (canceled) {
          return;
        }
        const bytes =
          result.bytes instanceof Uint8Array
            ? result.bytes
            : new Uint8Array(result.bytes);
        const arrayBuffer = bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength
        ) as ArrayBuffer;
        objectUrl = URL.createObjectURL(
          new Blob([arrayBuffer], { type: resolvedMimeType })
        );
        setState({ status: "ready", src: objectUrl });
      } catch {
        if (!canceled) {
          setState({ status: "error", reason: "read-failed" });
        }
      }
    }

    setState({ status: "loading" });
    void loadWorkspaceImage();

    return () => {
      canceled = true;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [localPath, mimeType, readWorkspaceImage, uri]);

  if (localPath && !readWorkspaceImage && renderUnavailableImage) {
    return (
      <>
        {unavailableImageRenderer({
          source: "image-generation-tool",
          reason: "unavailable",
          alt
        })}
      </>
    );
  }

  if (state.status === "loading") {
    return null;
  }

  if (state.status === "error") {
    return (
      <>
        {unavailableImageRenderer({
          source: "image-generation-tool",
          reason: state.reason,
          alt
        })}
      </>
    );
  }

  return (
    <ZoomableImage
      alt={alt}
      className={className}
      downloadName={localPath ? localPath.split(/[\\/]/).pop() : "image.png"}
      src={state.src}
      wrapElement="span"
      onError={() => setState({ status: "error", reason: "load-failed" })}
    />
  );
}
