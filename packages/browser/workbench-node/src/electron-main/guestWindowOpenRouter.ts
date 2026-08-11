import type { WebContents } from "electron";

export type BrowserGuestWindowOpenHandler = Parameters<
  WebContents["setWindowOpenHandler"]
>[0];

interface BrowserGuestWindowOpenCapableContents {
  setWindowOpenHandler?(handler: BrowserGuestWindowOpenHandler): void;
}

interface BrowserGuestWindowOpenRouteState {
  fallbackHandler: BrowserGuestWindowOpenHandler;
  hostHandler: BrowserGuestWindowOpenHandler | null;
  registeredHandler: BrowserGuestWindowOpenHandler | null;
}

const routeStateByContents = new WeakMap<
  object,
  BrowserGuestWindowOpenRouteState
>();

const denyUnownedPopup: BrowserGuestWindowOpenHandler = () => ({
  action: "deny"
});

function setWindowOpenRouterDelegate(
  contents: object,
  state: BrowserGuestWindowOpenRouteState
): void {
  const windowOpenContents = contents as BrowserGuestWindowOpenCapableContents;
  windowOpenContents.setWindowOpenHandler?.((details) => {
    const handler =
      state.hostHandler ?? state.registeredHandler ?? state.fallbackHandler;
    return handler(details);
  });
}

export function installBrowserGuestWindowOpenRouter(input: {
  contents: object;
  fallbackHandler: BrowserGuestWindowOpenHandler;
  hostHandler?: BrowserGuestWindowOpenHandler;
}): void {
  const existing = routeStateByContents.get(input.contents);
  if (existing) {
    existing.fallbackHandler = input.fallbackHandler;
    if (input.hostHandler) {
      existing.hostHandler = input.hostHandler;
    }
    return;
  }

  const state: BrowserGuestWindowOpenRouteState = {
    fallbackHandler: input.fallbackHandler,
    hostHandler: input.hostHandler ?? null,
    registeredHandler: null
  };
  routeStateByContents.set(input.contents, state);
  setWindowOpenRouterDelegate(input.contents, state);
}

export function restoreBrowserGuestWindowOpenRouter(input: {
  contents: object;
  fallbackHandler: BrowserGuestWindowOpenHandler;
}): void {
  const state = routeStateByContents.get(input.contents);
  if (!state) {
    installBrowserGuestWindowOpenRouter(input);
    return;
  }
  state.fallbackHandler = input.fallbackHandler;
  state.hostHandler = null;
  state.registeredHandler = null;
  setWindowOpenRouterDelegate(input.contents, state);
}

export function registerBrowserGuestWindowOpenRoute(
  contents: object,
  handler: BrowserGuestWindowOpenHandler
): () => void {
  if (!routeStateByContents.has(contents)) {
    installBrowserGuestWindowOpenRouter({
      contents,
      fallbackHandler: denyUnownedPopup
    });
  }

  const state = routeStateByContents.get(contents);
  if (!state) {
    return () => undefined;
  }
  state.registeredHandler = handler;

  return () => {
    if (state.registeredHandler === handler) {
      state.registeredHandler = null;
    }
  };
}
