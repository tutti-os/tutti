import assert from "node:assert/strict";
import test from "node:test";
import {
  chromeCookieImportPromptDismissedKey,
  createChromeCookieImportPromptAdapter
} from "./chromeCookieImportPrompt.ts";

test("Chrome import prompt dismissal is global and persisted", () => {
  const values = new Map<string, string>();
  let storageListener:
    | ((change: { key: string | null; newValue: string | null }) => void)
    | null = null;
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem(key: string, value: string) {
      values.set(key, value);
      storageListener?.({ key, newValue: value });
    }
  };
  const first = createChromeCookieImportPromptAdapter({
    storage,
    subscribeStorage(listener) {
      storageListener = listener;
      return () => {
        storageListener = null;
      };
    }
  });
  const second = createChromeCookieImportPromptAdapter({ storage });
  let notifications = 0;
  const unsubscribe = first.subscribe(() => {
    notifications += 1;
  });

  assert.equal(first.isDismissed(), false);
  first.dismiss();
  assert.equal(first.isDismissed(), true);
  assert.equal(values.get(chromeCookieImportPromptDismissedKey), "true");
  assert.equal(notifications, 1);
  unsubscribe();

  const restored = createChromeCookieImportPromptAdapter({ storage });
  assert.equal(restored.isDismissed(), true);
  assert.equal(second.isDismissed(), false);
});

test("Chrome import prompt reacts to cross-window storage changes", () => {
  let listener:
    | ((change: { key: string | null; newValue: string | null }) => void)
    | null = null;
  const adapter = createChromeCookieImportPromptAdapter({
    storage: null,
    subscribeStorage(nextListener) {
      listener = nextListener;
      return () => {
        listener = null;
      };
    }
  });
  let notifications = 0;
  const unsubscribe = adapter.subscribe(() => {
    notifications += 1;
  });

  const emitStorageChange = listener as unknown as (change: {
    key: string | null;
    newValue: string | null;
  }) => void;
  emitStorageChange({
    key: chromeCookieImportPromptDismissedKey,
    newValue: "true"
  });
  assert.equal(adapter.isDismissed(), true);
  assert.equal(notifications, 1);
  unsubscribe();
});

test("Chrome import prompt keeps in-memory dismissal when storage fails", () => {
  const adapter = createChromeCookieImportPromptAdapter({
    storage: {
      getItem() {
        throw new Error("unavailable");
      },
      setItem() {
        throw new Error("unavailable");
      }
    }
  });

  adapter.dismiss();
  assert.equal(adapter.isDismissed(), true);
});
