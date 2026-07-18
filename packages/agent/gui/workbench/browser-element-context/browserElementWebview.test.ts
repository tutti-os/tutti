import { describe, expect, it } from "vitest";
import type { BrowserNodeWebviewTag } from "@tutti-os/browser-node/react";
import {
  cancelBrowserElementWebviewSelection,
  executeBrowserElementWebviewScript,
  isBrowserElementWebviewReady,
  waitForBrowserElementWebviewReady
} from "./browserElementWebview.ts";

class MockBrowserElementWebview extends EventTarget {
  isConnected = true;
  ready = false;
  executedScripts: string[] = [];

  executeJavaScript<T>(script: string): Promise<T> {
    this.executedScripts.push(script);
    return Promise.resolve("selected" as T);
  }

  getWebContentsId(): number {
    if (!this.ready) {
      throw new Error(
        "The WebView must be attached to the DOM and the dom-ready event emitted"
      );
    }
    return 42;
  }
}

function asBrowserWebview(
  webview: MockBrowserElementWebview
): BrowserNodeWebviewTag {
  return webview as unknown as BrowserNodeWebviewTag;
}

describe("browser element webview", () => {
  it("waits for the active webview dom-ready event before execution", async () => {
    const mock = new MockBrowserElementWebview();
    const webview = asBrowserWebview(mock);
    const execution = executeBrowserElementWebviewScript<string>(
      webview,
      "select()",
      true
    );

    expect(mock.executedScripts).toEqual([]);
    mock.ready = true;
    mock.dispatchEvent(new Event("dom-ready"));

    expect(await execution).toBe("selected");
    expect(mock.executedScripts).toEqual(["select()"]);
  });

  it("fails detached webview readiness without executing", async () => {
    const mock = new MockBrowserElementWebview();
    mock.isConnected = false;
    const webview = asBrowserWebview(mock);

    expect(isBrowserElementWebviewReady(webview)).toBe(false);
    expect(await waitForBrowserElementWebviewReady(webview, 1)).toBe(false);
    await expect(
      executeBrowserElementWebviewScript(webview, "select()")
    ).rejects.toThrow(/not ready/u);
    expect(mock.executedScripts).toEqual([]);
  });

  it("ignores a webview detached during cancellation cleanup", async () => {
    const mock = new MockBrowserElementWebview();
    mock.isConnected = false;

    await cancelBrowserElementWebviewSelection(
      asBrowserWebview(mock),
      "cancel()"
    );

    expect(mock.executedScripts).toEqual([]);
  });
});
