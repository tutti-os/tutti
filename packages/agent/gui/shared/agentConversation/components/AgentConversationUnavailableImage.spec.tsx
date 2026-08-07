import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentMessageMarkdown } from "../../AgentMessageMarkdown";
import type { AgentMessageContentVM } from "../contracts/agentMessageRowVM";
import type { AgentConversationUnavailableImageRenderer } from "../contracts/agentConversationUnavailableImage";
import { AgentGeneratedImageRow } from "./AgentGeneratedImageRow";
import { AgentUserImageGrid } from "./AgentMessageImages";

describe("Agent conversation unavailable-image renderer", () => {
  beforeEach(() => {
    delete (window as { agentGUIRuntime?: unknown }).agentGUIRuntime;
    window.agentHostApi = {
      filesystem: {},
      workspace: {
        readFile: vi.fn().mockRejectedValue(new Error("not shared"))
      }
    } as unknown as typeof window.agentHostApi;
  });

  it("renders the default fallback for a path-only user image", () => {
    render(<AgentUserImageGrid message={userImageMessage()} />);

    expectDefaultFallback("user-message", "unavailable");
  });

  it("renders the default fallback when a local Markdown image read fails", async () => {
    render(
      <AgentMessageMarkdown content="![generated image](/workspace/output/imagegen/dance.png)" />
    );

    await screen.findByTestId("agent-conversation-unavailable-image");
    expectDefaultFallback("assistant-markdown", "read-failed");
  });

  it("renders the default fallback when an image-generation artifact read fails", async () => {
    render(<AgentGeneratedImageRow row={generatedImageRow()} />);

    await screen.findByTestId("agent-conversation-unavailable-image");
    expectDefaultFallback("image-generation-tool", "read-failed");
  });

  it("renders the default fallback after a browser image load failure", async () => {
    render(<AgentGeneratedImageRow row={remoteGeneratedImageRow()} />);

    fireEvent.error(screen.getByRole("img"));

    await waitFor(() => {
      expectDefaultFallback("image-generation-tool", "load-failed");
    });
  });

  it("renders the host slot for a path-only user image", () => {
    const renderUnavailableImage = unavailableImageRenderer();

    render(
      <AgentUserImageGrid
        message={userImageMessage()}
        renderUnavailableImage={renderUnavailableImage}
      />
    );

    expect(screen.getByTestId("unavailable-image")).toHaveTextContent(
      "user-message:unavailable:screen.png"
    );
    expect(renderUnavailableImage).toHaveBeenCalledWith({
      source: "user-message",
      reason: "unavailable",
      alt: "screen.png"
    });
  });

  it("renders the host slot when a local Markdown image read fails", async () => {
    const renderUnavailableImage = unavailableImageRenderer();

    render(
      <AgentMessageMarkdown
        content="![generated image](/workspace/output/imagegen/dance.png)"
        renderUnavailableImage={renderUnavailableImage}
      />
    );

    expect(await screen.findByTestId("unavailable-image")).toHaveTextContent(
      "assistant-markdown:read-failed:generated image"
    );
  });

  it("renders the host slot when an image-generation artifact read fails", async () => {
    const renderUnavailableImage = unavailableImageRenderer();

    render(
      <AgentGeneratedImageRow
        row={generatedImageRow()}
        renderUnavailableImage={renderUnavailableImage}
      />
    );

    expect(await screen.findByTestId("unavailable-image")).toHaveTextContent(
      "image-generation-tool:read-failed:Image generation preview"
    );
  });

  it("renders the host slot after a browser image load failure", async () => {
    const renderUnavailableImage = unavailableImageRenderer();

    render(
      <AgentGeneratedImageRow
        row={remoteGeneratedImageRow()}
        renderUnavailableImage={renderUnavailableImage}
      />
    );

    fireEvent.error(screen.getByRole("img"));

    await waitFor(() => {
      expect(screen.getByTestId("unavailable-image")).toHaveTextContent(
        "image-generation-tool:load-failed:Image generation preview"
      );
    });
  });
});

function expectDefaultFallback(source: string, reason: string): void {
  const fallback = screen.getByTestId("agent-conversation-unavailable-image");
  expect(fallback).toHaveTextContent(
    "Image preview is temporarily unavailable"
  );
  expect(fallback).toHaveAttribute(
    "data-agent-conversation-unavailable-image-source",
    source
  );
  expect(fallback).toHaveAttribute(
    "data-agent-conversation-unavailable-image-reason",
    reason
  );
}

function unavailableImageRenderer() {
  const renderer: AgentConversationUnavailableImageRenderer = (context) => (
    <div data-testid="unavailable-image">
      {context.source}:{context.reason}:{context.alt}
    </div>
  );
  return vi.fn(renderer);
}

function userImageMessage(): AgentMessageContentVM {
  return {
    kind: "message-content",
    id: "user-images-1",
    turnId: "turn-1",
    body: "",
    presentationKind: "content",
    contentKind: "image-grid",
    images: [
      {
        id: "image-1",
        workspaceId: "room-1",
        agentSessionId: "session-1",
        mimeType: "image/png",
        name: "screen.png",
        path: "/workspace/prompt-assets/screen.png"
      }
    ],
    occurredAtUnixMs: 1
  };
}

function generatedImageRow() {
  return {
    kind: "generated-image" as const,
    id: "generated-image:call-1",
    turnId: "turn-1",
    sourceCallId: "call-1",
    uri: "/workspace/output/imagegen/dance.png",
    mimeType: "image/png",
    prompt: "A dancer",
    occurredAtUnixMs: 1
  };
}

function remoteGeneratedImageRow() {
  return {
    kind: "generated-image" as const,
    id: "generated-image:call-remote",
    turnId: "turn-1",
    sourceCallId: "call-remote",
    uri: "https://assets.example.test/image.png",
    mimeType: "image/png",
    prompt: null,
    occurredAtUnixMs: 1
  };
}
