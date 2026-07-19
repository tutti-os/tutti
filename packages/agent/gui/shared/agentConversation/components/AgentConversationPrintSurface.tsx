import { useCallback, type JSX } from "react";
import { createPortal } from "react-dom";
import type { AgentMessageMarkdownWorkspaceAppIcon } from "../../AgentMessageMarkdown";
import type { AgentGUIProviderSkillOption } from "../../../agent-gui/agentGuiNode/model/agentGuiNodeTypes";
import type { AgentConversationVM } from "../contracts/agentConversationVM";
import type { AgentTurnDisclosureStore } from "./AgentTurnDisclosureContext";
import { AgentTranscriptView } from "./AgentTranscriptView";

const PRINT_ASSET_WAIT_TIMEOUT_MS = 4_000;

export function AgentConversationPrintSurface({
  availableSkills,
  conversation,
  expandedToolRowKeys,
  labels,
  onReady,
  requestId,
  turnExpandedOverrides,
  workspaceAppIcons
}: {
  availableSkills?: readonly AgentGUIProviderSkillOption[];
  conversation: AgentConversationVM;
  expandedToolRowKeys: ReadonlySet<string>;
  labels: {
    toolCallsLabel: (count: number) => string;
    thinkingLabel: string;
    processing: string;
    turnSummary: string;
  };
  onReady: (requestId: number) => void;
  requestId: number;
  turnExpandedOverrides: Readonly<Record<string, boolean>>;
  workspaceAppIcons?: readonly AgentMessageMarkdownWorkspaceAppIcon[];
}): JSX.Element | null {
  const turnDisclosureStore: AgentTurnDisclosureStore = {
    expandedOverrides: turnExpandedOverrides,
    setExpandedOverride: () => undefined
  };
  const bindPrintSurface = useCallback(
    (surface: HTMLDivElement | null) => {
      if (!surface) return;
      let canceled = false;
      void waitForConversationPrintSurface(surface).then(() => {
        if (!canceled && surface.isConnected) onReady(requestId);
      });
      return () => {
        canceled = true;
      };
    },
    [onReady, requestId]
  );

  if (typeof document === "undefined" || !document.body) return null;

  return createPortal(
    <div
      ref={bindPrintSurface}
      aria-hidden="true"
      className="agent-conversation-print-surface agent-gui-node__shell"
      data-agent-conversation-print-surface="true"
    >
      <main className="agent-conversation-print-surface__timeline agent-gui-node__timeline">
        <AgentTranscriptView
          availableSkills={availableSkills}
          conversation={conversation}
          expandedToolRowKeys={expandedToolRowKeys}
          labels={labels}
          previewMode
          printMode
          turnDisclosureStore={turnDisclosureStore}
          workspaceAppIcons={workspaceAppIcons}
        />
      </main>
    </div>,
    document.body
  );
}

async function waitForConversationPrintSurface(
  surface: HTMLElement | null
): Promise<void> {
  await nextAnimationFrame();
  await nextAnimationFrame();
  if (!surface) return;

  const fontsReady = document.fonts?.ready ?? Promise.resolve();
  const imagesReady = Promise.all(
    Array.from(surface.querySelectorAll("img")).map(waitForImage)
  );
  const timeoutSignal = AbortSignal.timeout(PRINT_ASSET_WAIT_TIMEOUT_MS);
  let resolveTimeout = (): void => undefined;
  const onTimeout = (): void => resolveTimeout();
  const timeoutPromise = new Promise<void>((resolve) => {
    resolveTimeout = resolve;
    // timing: broken or remote images must not block PDF export indefinitely.
    timeoutSignal.addEventListener("abort", onTimeout, { once: true });
  });
  try {
    await Promise.race([
      Promise.all([fontsReady, imagesReady]),
      timeoutPromise
    ]);
  } finally {
    timeoutSignal.removeEventListener("abort", onTimeout);
  }
}

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

function waitForImage(image: HTMLImageElement): Promise<void> {
  if (image.complete) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = (): void => resolve();
    image.addEventListener("load", finish, { once: true });
    image.addEventListener("error", finish, { once: true });
  });
}
