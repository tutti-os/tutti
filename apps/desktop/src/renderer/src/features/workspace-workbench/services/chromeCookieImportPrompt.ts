import type { BrowserNodeChromeImportPromptAdapter } from "@tutti-os/browser-node";

export const chromeCookieImportPromptDismissedKey =
  "tutti.browser.chromeImportPrompt.dismissed.v1";

interface PromptStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface PromptStorageChange {
  key: string | null;
  newValue: string | null;
}

export function createChromeCookieImportPromptAdapter(input: {
  storage?: PromptStorage | null;
  subscribeStorage?: (
    listener: (change: PromptStorageChange) => void
  ) => () => void;
}): BrowserNodeChromeImportPromptAdapter {
  const listeners = new Set<() => void>();
  let dismissed = readDismissed(input.storage);
  let unsubscribeStorage: (() => void) | null = null;

  const publish = (nextDismissed: boolean): void => {
    if (dismissed === nextDismissed) {
      return;
    }
    dismissed = nextDismissed;
    for (const listener of listeners) {
      listener();
    }
  };

  return {
    dismiss() {
      publish(true);
      try {
        input.storage?.setItem(chromeCookieImportPromptDismissedKey, "true");
      } catch {
        // The in-memory dismissal still applies for this application launch.
      }
    },
    isDismissed() {
      return dismissed;
    },
    subscribe(listener) {
      listeners.add(listener);
      if (!unsubscribeStorage && input.subscribeStorage) {
        unsubscribeStorage = input.subscribeStorage((change) => {
          if (change.key === chromeCookieImportPromptDismissedKey) {
            publish(change.newValue === "true");
          }
        });
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          unsubscribeStorage?.();
          unsubscribeStorage = null;
        }
      };
    }
  };
}

let desktopPromptAdapter: BrowserNodeChromeImportPromptAdapter | null = null;

export function getDesktopChromeCookieImportPromptAdapter(): BrowserNodeChromeImportPromptAdapter {
  if (desktopPromptAdapter) {
    return desktopPromptAdapter;
  }
  desktopPromptAdapter = createChromeCookieImportPromptAdapter({
    storage: resolveDesktopPromptStorage(),
    subscribeStorage:
      typeof window === "undefined"
        ? undefined
        : (listener) => {
            const handleStorage = (event: StorageEvent): void =>
              listener({ key: event.key, newValue: event.newValue });
            window.addEventListener("storage", handleStorage);
            return () => window.removeEventListener("storage", handleStorage);
          }
  });
  return desktopPromptAdapter;
}

function resolveDesktopPromptStorage(): PromptStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function readDismissed(storage: PromptStorage | null | undefined): boolean {
  try {
    return storage?.getItem(chromeCookieImportPromptDismissedKey) === "true";
  } catch {
    return false;
  }
}
