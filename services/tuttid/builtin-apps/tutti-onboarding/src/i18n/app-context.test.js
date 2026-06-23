import { describe, expect, it, vi } from "vitest";

import {
  normalizeLocale,
  readHostLocale,
  readQueryLocale,
  resolveAppLocale,
  subscribeHostLocale
} from "./app-context";

describe("Tutti onboarding locale", () => {
  it("normalizes supported locale tags", () => {
    expect(normalizeLocale(undefined)).toBe("en-US");
    expect(normalizeLocale("en")).toBe("en-US");
    expect(normalizeLocale("en-US")).toBe("en-US");
    expect(normalizeLocale("zh")).toBe("zh-CN");
    expect(normalizeLocale("zh_CN")).toBe("zh-CN");
    expect(normalizeLocale("fr-FR")).toBe("en-US");
  });

  it("reads query locale overrides for local web debugging", () => {
    expect(readQueryLocale({ location: { search: "?locale=zh-CN" } })).toBe(
      "zh-CN"
    );
    expect(readQueryLocale({ location: { search: "?lang=en" } })).toBe("en");
    expect(readQueryLocale({ location: { search: "" } })).toBeNull();
  });

  it("lets the app query locale override host locale resolution", () => {
    expect(resolveAppLocale("en", "zh-CN")).toBe("en-US");
    expect(resolveAppLocale("zh-CN", "en-US")).toBe("zh-CN");
    expect(resolveAppLocale(undefined, "zh-CN")).toBe("zh-CN");
  });

  it("reads the locale from window.tuttiExternal.app.getContext", async () => {
    const host = {
      tuttiExternal: {
        app: {
          getContext: async () => ({ locale: "zh-CN" })
        }
      }
    };

    expect(await readHostLocale(host)).toBe("zh-CN");
  });

  it("subscribes to host locale changes through tuttiExternal.app", () => {
    const unsubscribe = vi.fn();
    const listener = vi.fn();
    const host = {
      tuttiExternal: {
        app: {
          subscribe: (callback) => {
            callback({ language: "en-US" });
            callback({ agentBound: true });
            callback({ locale: "zh-CN" });
            return unsubscribe;
          }
        }
      }
    };

    expect(subscribeHostLocale(listener, host)).toBe(unsubscribe);
    expect(listener).toHaveBeenNthCalledWith(1, "en-US");
    expect(listener).toHaveBeenNthCalledWith(2, "zh-CN");
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
