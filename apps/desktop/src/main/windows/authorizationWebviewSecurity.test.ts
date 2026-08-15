import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Event, Session, WebContents, WebPreferences } from "electron";
import {
  enforceAuthorizationWebviewSecurity,
  installAuthorizationWebviewSecurity
} from "./authorizationWebviewSecurity.ts";

test("authorization webview enforcement isolates a credential-free HTTPS page", () => {
  const params = {
    "data-tutti-authorization-webview": "true",
    allowpopups: "true",
    partition: "tutti-authorization:view-123",
    src: "https://work.weixin.qq.com/ai/qc/gen?scode=opaque"
  };
  const webPreferences = {
    nodeIntegration: true,
    preload: "/unsafe/preload.js",
    sandbox: false
  } as WebPreferences;

  const result = enforceAuthorizationWebviewSecurity({
    params,
    webPreferences
  });

  assert.deepEqual(result, {
    allowed: true,
    origin: "https://work.weixin.qq.com",
    reason: null
  });
  assert.equal(webPreferences.contextIsolation, true);
  assert.equal(webPreferences.nodeIntegration, false);
  assert.equal(webPreferences.preload, undefined);
  assert.equal(webPreferences.sandbox, true);
  assert.equal(params.allowpopups, undefined);
});

test("authorization webview enforcement rejects unsafe URLs and partitions", () => {
  for (const params of [
    {
      partition: "browser-node-incognito",
      src: "https://work.weixin.qq.com/"
    },
    {
      partition: "tutti-authorization:view-123",
      src: "http://work.weixin.qq.com/"
    },
    {
      partition: "tutti-authorization:view-123",
      src: "https://user:secret@work.weixin.qq.com/"
    }
  ]) {
    assert.equal(
      enforceAuthorizationWebviewSecurity({
        params,
        webPreferences: {} as WebPreferences
      }).allowed,
      false
    );
  }
});

test("authorization guests keep same-origin navigation and externalize the rest", () => {
  const contents = new EventEmitter();
  const authorizationSession = {} as Session;
  const guest = new EventEmitter() as EventEmitter & {
    session: Session;
    setWindowOpenHandler(
      handler: (details: { url: string }) => {
        action: "deny";
      }
    ): void;
    windowOpenHandler?: (details: { url: string }) => { action: "deny" };
  };
  guest.session = authorizationSession;
  guest.setWindowOpenHandler = (handler) => {
    guest.windowOpenHandler = handler;
  };
  const opened: string[] = [];
  const cleanup = installAuthorizationWebviewSecurity({
    contents: contents as unknown as WebContents,
    openExternal: (url) => {
      opened.push(url);
    },
    resolveSession: () => authorizationSession
  });
  const params = {
    "data-tutti-authorization-webview": "true",
    partition: "tutti-authorization:view-123",
    src: "https://work.weixin.qq.com/ai/qc/gen?scode=opaque"
  };

  contents.emit(
    "will-attach-webview",
    { preventDefault() {} } as Event,
    {} as WebPreferences,
    params
  );
  contents.emit("did-attach-webview", {} as Event, {
    session: {} as Session
  });
  contents.emit("did-attach-webview", {} as Event, guest);

  let sameOriginPrevented = false;
  guest.emit(
    "will-navigate",
    {
      preventDefault: () => {
        sameOriginPrevented = true;
      }
    } as unknown as Event,
    "https://work.weixin.qq.com/ai/qc/status"
  );
  let crossOriginPrevented = false;
  guest.emit(
    "will-redirect",
    {
      preventDefault: () => {
        crossOriginPrevented = true;
      }
    } as unknown as Event,
    "https://example.com/help"
  );
  assert.deepEqual(
    guest.windowOpenHandler?.({ url: "https://example.org/docs" }),
    { action: "deny" }
  );
  cleanup();

  assert.equal(sameOriginPrevented, false);
  assert.equal(crossOriginPrevented, true);
  assert.deepEqual(opened, [
    "https://example.com/help",
    "https://example.org/docs"
  ]);
});
