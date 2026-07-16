import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Button,
  InspectIcon,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  cn
} from "@tutti-os/ui-system";
import { useActiveBrowserNodeWebview } from "@tutti-os/browser-node/react";
import type { BrowserNodeWebviewTag } from "@tutti-os/browser-node/react";
import {
  normalizeBrowserElementSelectionResult,
  serializeBrowserElementSnapshot
} from "./browserElementSnapshot";
import {
  browserElementSelectorScript,
  cancelBrowserElementSelectorScript
} from "./browserElementSelectorScript";
import {
  cancelBrowserElementWebviewSelection,
  executeBrowserElementWebviewScript
} from "./browserElementWebview";
import { createBrowserElementMentionMarkdown } from "./browserElementMention";

export interface BrowserElementContextCopy {
  cancel: string;
  failed: string;
  select: string;
}

interface BrowserElementSelectionSession {
  attempt: number;
  navigationPending: boolean;
  webview: BrowserNodeWebviewTag | null;
}

export function BrowserElementContextAction({
  copy,
  onAppendMention,
  onError,
  workspaceId
}: {
  copy: BrowserElementContextCopy;
  onAppendMention: (mention: string) => void;
  onError: (message: string) => void;
  workspaceId: string;
}): ReactNode {
  const [state, setState] = useState<"idle" | "selecting">("idle");
  const mountedRef = useRef(true);
  const selectionSessionRef = useRef<BrowserElementSelectionSession | null>(
    null
  );
  const activeWebview = useActiveBrowserNodeWebview();

  const isCurrentSelectionAttempt = useCallback(
    (session: BrowserElementSelectionSession, attempt: number): boolean =>
      selectionSessionRef.current === session && session.attempt === attempt,
    []
  );

  const endSelection = useCallback(
    (session: BrowserElementSelectionSession): void => {
      if (selectionSessionRef.current !== session) return;
      selectionSessionRef.current = null;
      session.attempt += 1;
      const webview = session.webview;
      session.webview = null;
      void cancelBrowserElementWebviewSelection(
        webview,
        cancelBrowserElementSelectorScript
      );
      if (mountedRef.current) setState("idle");
    },
    []
  );

  const runSelectionAttempt = useCallback(
    async (
      session: BrowserElementSelectionSession,
      webview: BrowserNodeWebviewTag,
      attempt: number
    ): Promise<void> => {
      try {
        const rawResult = await executeBrowserElementWebviewScript(
          webview,
          browserElementSelectorScript,
          true
        );
        if (!isCurrentSelectionAttempt(session, attempt)) return;
        const result = normalizeBrowserElementSelectionResult(rawResult);
        if (!result || result.status === "cancelled") {
          endSelection(session);
          return;
        }
        const content = serializeBrowserElementSnapshot(result.snapshot);
        const mention = createBrowserElementMentionMarkdown({
          context: content,
          id: createBrowserElementReferenceId(),
          tagName: result.snapshot.element.tagName,
          workspaceId
        });
        if (!mention) {
          throw new Error("Browser element mention could not be created");
        }
        onAppendMention(mention);
        endSelection(session);
      } catch {
        if (!isCurrentSelectionAttempt(session, attempt)) return;
        // A guest navigation destroys the injected Promise. Keep the
        // selection session alive until the new document emits dom-ready.
        if (session.navigationPending) return;
        onError(copy.failed);
        endSelection(session);
      }
    },
    [
      copy.failed,
      endSelection,
      isCurrentSelectionAttempt,
      onAppendMention,
      onError,
      workspaceId
    ]
  );

  const moveSelectionToWebview = useCallback(
    async (
      session: BrowserElementSelectionSession,
      webview: BrowserNodeWebviewTag,
      force = false
    ): Promise<void> => {
      if (selectionSessionRef.current !== session) return;
      if (!force && session.webview === webview && session.attempt > 0) {
        return;
      }
      const previousWebview = session.webview;
      session.webview = webview;
      session.navigationPending = false;
      const attempt = ++session.attempt;
      await cancelBrowserElementWebviewSelection(
        previousWebview && (force || previousWebview !== webview)
          ? previousWebview
          : null,
        cancelBrowserElementSelectorScript
      );
      if (!isCurrentSelectionAttempt(session, attempt)) return;
      void runSelectionAttempt(session, webview, attempt);
    },
    [isCurrentSelectionAttempt, runSelectionAttempt]
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const session = selectionSessionRef.current;
      if (session) {
        selectionSessionRef.current = null;
        session.attempt += 1;
        void cancelBrowserElementWebviewSelection(
          session.webview,
          cancelBrowserElementSelectorScript
        );
        session.webview = null;
      }
    };
  }, []);

  const cancelSelection = useCallback(() => {
    const session = selectionSessionRef.current;
    if (session) endSelection(session);
  }, [endSelection]);

  const startSelection = useCallback(async () => {
    if (selectionSessionRef.current) {
      cancelSelection();
      return;
    }
    const webview = activeWebview;
    if (!webview?.executeJavaScript) {
      onError(copy.failed);
      return;
    }
    const session: BrowserElementSelectionSession = {
      attempt: 0,
      navigationPending: false,
      webview: null
    };
    selectionSessionRef.current = session;
    setState("selecting");
    await moveSelectionToWebview(session, webview, true);
  }, [
    cancelSelection,
    copy.failed,
    moveSelectionToWebview,
    onError,
    activeWebview
  ]);

  useEffect(() => {
    const session = selectionSessionRef.current;
    if (state !== "selecting" || !session || !activeWebview) return;
    const webview = activeWebview;
    const handleStartLoading = (): void => {
      if (selectionSessionRef.current === session) {
        session.navigationPending = true;
      }
    };
    const handleDomReady = (): void => {
      session.navigationPending = false;
      void moveSelectionToWebview(session, webview, true);
    };
    webview.addEventListener("did-start-loading", handleStartLoading);
    webview.addEventListener("dom-ready", handleDomReady);
    void moveSelectionToWebview(session, webview);
    return () => {
      webview.removeEventListener("did-start-loading", handleStartLoading);
      webview.removeEventListener("dom-ready", handleDomReady);
    };
  }, [activeWebview, moveSelectionToWebview, state]);

  const label = state === "selecting" ? copy.cancel : copy.select;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label={label}
          aria-pressed={state === "selecting"}
          className={cn(
            "nodrag shrink-0 rounded-md",
            state === "selecting" &&
              "bg-[var(--transparency-block)] text-[var(--text-primary)]"
          )}
          size="icon-sm"
          type="button"
          variant="chrome"
          onClick={() => void startSelection()}
        >
          <InspectIcon className="size-[15px]" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

function createBrowserElementReferenceId(): string {
  return `browser-element:${
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(36).slice(2)}`
  }`;
}
