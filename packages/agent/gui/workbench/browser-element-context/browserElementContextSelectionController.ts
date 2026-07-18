import type { BrowserNodeWebviewTag } from "@tutti-os/browser-node/react";
import {
  normalizeBrowserElementSelectionResult,
  serializeBrowserElementSnapshot
} from "./browserElementSnapshot.ts";
import {
  browserElementSelectorScript,
  cancelBrowserElementSelectorScript
} from "./browserElementSelectorScript.ts";
import {
  cancelBrowserElementWebviewSelection,
  executeBrowserElementWebviewScript
} from "./browserElementWebview.ts";
import { createBrowserElementMentionMarkdown } from "./browserElementMention.ts";

export interface BrowserElementSelectionControllerInput {
  failedCopy: string;
  onAppendMention: (mention: string) => void;
  onError: (message: string) => void;
  workspaceId: string;
}

export interface BrowserElementSelectionSnapshot {
  state: "idle" | "selecting";
}

interface BrowserElementSelectionSession {
  attempt: number;
  navigationPending: boolean;
  webview: BrowserNodeWebviewTag | null;
}

export class BrowserElementContextSelectionController {
  private activeWebview: BrowserNodeWebviewTag | null = null;
  private detachFrame: number | null = null;
  private input: BrowserElementSelectionControllerInput;
  private readonly listeners = new Set<
    (snapshot: BrowserElementSelectionSnapshot) => void
  >();
  private session: BrowserElementSelectionSession | null = null;
  private snapshot: BrowserElementSelectionSnapshot = { state: "idle" };
  private subscribedWebview: BrowserNodeWebviewTag | null = null;

  constructor(input: BrowserElementSelectionControllerInput) {
    this.input = input;
  }

  readonly getSnapshot = (): BrowserElementSelectionSnapshot => this.snapshot;

  readonly subscribe = (
    listener: (snapshot: BrowserElementSelectionSnapshot) => void
  ): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  configure(input: BrowserElementSelectionControllerInput): void {
    this.input = input;
  }

  bindAction(
    node: HTMLButtonElement | null,
    activeWebview: BrowserNodeWebviewTag | null
  ): void {
    if (node) {
      if (this.detachFrame !== null) {
        cancelAnimationFrame(this.detachFrame);
        this.detachFrame = null;
      }
      this.moveToActiveWebview(activeWebview);
      return;
    }
    if (this.detachFrame !== null) cancelAnimationFrame(this.detachFrame);
    this.detachFrame = requestAnimationFrame(() => {
      this.detachFrame = null;
      this.dispose();
    });
  }

  toggle(activeWebview: BrowserNodeWebviewTag | null): void {
    if (this.session) {
      this.endSelection(this.session);
      return;
    }
    if (!activeWebview?.executeJavaScript) {
      this.input.onError(this.input.failedCopy);
      return;
    }
    const session: BrowserElementSelectionSession = {
      attempt: 0,
      navigationPending: false,
      webview: null
    };
    this.session = session;
    this.setState("selecting");
    this.moveToActiveWebview(activeWebview);
  }

  private readonly handleStartLoading = (): void => {
    if (this.session) this.session.navigationPending = true;
  };

  private readonly handleDomReady = (): void => {
    const session = this.session;
    const webview = this.activeWebview;
    if (!session || !webview) return;
    session.navigationPending = false;
    void this.moveSelectionToWebview(session, webview, true);
  };

  private moveToActiveWebview(webview: BrowserNodeWebviewTag | null): void {
    this.activeWebview = webview;
    const session = this.session;
    if (!session) return;
    if (!webview) {
      const previousWebview = session.webview;
      session.webview = null;
      session.attempt += 1;
      this.unsubscribeFromWebview();
      void cancelBrowserElementWebviewSelection(
        previousWebview,
        cancelBrowserElementSelectorScript
      );
      return;
    }
    this.subscribeToWebview(webview);
    void this.moveSelectionToWebview(session, webview);
  }

  private subscribeToWebview(webview: BrowserNodeWebviewTag): void {
    if (this.subscribedWebview === webview) return;
    this.unsubscribeFromWebview();
    this.subscribedWebview = webview;
    webview.addEventListener("did-start-loading", this.handleStartLoading);
    webview.addEventListener("dom-ready", this.handleDomReady);
  }

  private unsubscribeFromWebview(): void {
    this.subscribedWebview?.removeEventListener(
      "did-start-loading",
      this.handleStartLoading
    );
    this.subscribedWebview?.removeEventListener(
      "dom-ready",
      this.handleDomReady
    );
    this.subscribedWebview = null;
  }

  private async moveSelectionToWebview(
    session: BrowserElementSelectionSession,
    webview: BrowserNodeWebviewTag,
    force = false
  ): Promise<void> {
    if (this.session !== session) return;
    if (!force && session.webview === webview && session.attempt > 0) return;
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
    if (!this.isCurrentSelectionAttempt(session, attempt)) return;
    void this.runSelectionAttempt(session, webview, attempt);
  }

  private async runSelectionAttempt(
    session: BrowserElementSelectionSession,
    webview: BrowserNodeWebviewTag,
    attempt: number
  ): Promise<void> {
    try {
      const rawResult = await executeBrowserElementWebviewScript(
        webview,
        browserElementSelectorScript,
        true
      );
      if (!this.isCurrentSelectionAttempt(session, attempt)) return;
      const result = normalizeBrowserElementSelectionResult(rawResult);
      if (!result || result.status === "cancelled") {
        this.endSelection(session);
        return;
      }
      const content = serializeBrowserElementSnapshot(result.snapshot);
      const mention = createBrowserElementMentionMarkdown({
        context: content,
        id: createBrowserElementReferenceId(),
        tagName: result.snapshot.element.tagName,
        workspaceId: this.input.workspaceId
      });
      if (!mention)
        throw new Error("Browser element mention could not be created");
      this.input.onAppendMention(mention);
      this.endSelection(session);
    } catch {
      if (!this.isCurrentSelectionAttempt(session, attempt)) return;
      // A guest navigation destroys the injected Promise. Keep the selection
      // session alive until the new document emits dom-ready.
      if (session.navigationPending) return;
      this.input.onError(this.input.failedCopy);
      this.endSelection(session);
    }
  }

  private isCurrentSelectionAttempt(
    session: BrowserElementSelectionSession,
    attempt: number
  ): boolean {
    return this.session === session && session.attempt === attempt;
  }

  private endSelection(session: BrowserElementSelectionSession): void {
    if (this.session !== session) return;
    this.session = null;
    session.attempt += 1;
    const webview = session.webview;
    session.webview = null;
    this.unsubscribeFromWebview();
    void cancelBrowserElementWebviewSelection(
      webview,
      cancelBrowserElementSelectorScript
    );
    this.setState("idle");
  }

  private setState(state: BrowserElementSelectionSnapshot["state"]): void {
    if (this.snapshot.state === state) return;
    this.snapshot = { state };
    for (const listener of this.listeners) listener(this.snapshot);
  }

  private dispose(): void {
    const session = this.session;
    if (session) this.endSelection(session);
    this.unsubscribeFromWebview();
    this.activeWebview = null;
  }
}

function createBrowserElementReferenceId(): string {
  return `browser-element:${
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(36).slice(2)}`
  }`;
}
