import { describe, expect, it, vi } from "vitest";
import { refreshComposerSlashCapabilities } from "./useComposerSlashCapabilitiesRefresh";

describe("refreshComposerSlashCapabilities", () => {
  it.each([
    { name: "slash", skillQuery: null, slashQuery: "" },
    { name: "skill", skillQuery: "", slashQuery: null }
  ])("refreshes capabilities again when $name search is reopened", (query) => {
    const onRetryComposerOptions = vi.fn();
    const refreshedSessionRef = { current: null as string | null };
    const refresh = (isPaletteOpen: boolean): void =>
      refreshComposerSlashCapabilities({
        capabilitiesScopeKey: "session-1\u0000target-a\u0000/workspace/a",
        isPaletteOpen,
        onRetryComposerOptions,
        refreshedSessionRef,
        skillQuery: query.skillQuery,
        slashQuery: query.slashQuery
      });

    refresh(true);
    expect(onRetryComposerOptions).toHaveBeenCalledTimes(1);
    refresh(false);
    refresh(true);
    expect(onRetryComposerOptions).toHaveBeenCalledTimes(2);
    expect(onRetryComposerOptions).toHaveBeenLastCalledWith({
      force: true,
      section: "capabilities"
    });

    refresh(true);
    expect(onRetryComposerOptions).toHaveBeenCalledTimes(2);
  });

  it("refreshes an open skill query when its target scope changes", () => {
    const onRetryComposerOptions = vi.fn();
    const refreshedSessionRef = { current: null as string | null };
    const refresh = (capabilitiesScopeKey: string): void =>
      refreshComposerSlashCapabilities({
        capabilitiesScopeKey,
        isPaletteOpen: true,
        onRetryComposerOptions,
        refreshedSessionRef,
        skillQuery: "",
        slashQuery: null
      });

    refresh("draft\u0000target-a\u0000/workspace/a");
    refresh("draft\u0000target-b\u0000/workspace/b");

    expect(onRetryComposerOptions).toHaveBeenCalledTimes(2);
  });
});
