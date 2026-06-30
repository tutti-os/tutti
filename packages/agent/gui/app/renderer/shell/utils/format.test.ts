import { afterEach, describe, expect, it, vi } from "vitest";
import { setCurrentAgentGuiI18nLocaleForTests } from "../../../../i18n/runtime";
import { formatAgentMessageTimestamp, toRelativeTime } from "./format";

describe("toRelativeTime", () => {
  afterEach(() => {
    setCurrentAgentGuiI18nLocaleForTests("en");
    vi.useRealTimers();
  });

  it("formats relative timestamps for English locale", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-24T12:00:00Z"));
    setCurrentAgentGuiI18nLocaleForTests("en");

    expect(toRelativeTime("2026-06-14T12:00:00Z")).toBe("10 days ago");
    expect(toRelativeTime("2026-04-24T12:00:00Z")).toBe("2 months ago");
    expect(toRelativeTime("2024-06-24T12:00:00Z")).toBe("2 years ago");
  });

  it("formats relative timestamps for Chinese locale with readable digit spacing", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-24T12:00:00Z"));
    setCurrentAgentGuiI18nLocaleForTests("zh-CN");

    expect(toRelativeTime("2026-06-14T12:00:00Z")).toBe("10 天前");
    expect(toRelativeTime("2026-04-24T12:00:00Z")).toBe("2 个月前");
    expect(toRelativeTime("2024-06-24T12:00:00Z")).toBe("2 年前");
  });
});

describe("formatAgentMessageTimestamp", () => {
  afterEach(() => {
    setCurrentAgentGuiI18nLocaleForTests("en");
    vi.useRealTimers();
  });

  it("formats messages from the current week as weekday and time", () => {
    vi.useFakeTimers();
    const now = new Date(2026, 5, 28, 21, 30);
    vi.setSystemTime(now);
    setCurrentAgentGuiI18nLocaleForTests("en");

    const timestamp = new Date(2026, 5, 28, 20, 7).getTime();

    expect(formatAgentMessageTimestamp(timestamp)).toBe("Sunday 20:07");
  });

  it("uses Monday as the start of the current week", () => {
    vi.useFakeTimers();
    const now = new Date(2026, 5, 28, 21, 30);
    vi.setSystemTime(now);
    setCurrentAgentGuiI18nLocaleForTests("en");

    const timestamp = new Date(2026, 5, 22, 0, 0).getTime();

    expect(formatAgentMessageTimestamp(timestamp)).toBe("Monday 00:00");
  });

  it("formats messages from last week with short date and time", () => {
    vi.useFakeTimers();
    const now = new Date(2026, 5, 28, 21, 30);
    vi.setSystemTime(now);
    setCurrentAgentGuiI18nLocaleForTests("en");

    const timestamp = new Date(2026, 5, 21, 20, 7).getTime();

    expect(formatAgentMessageTimestamp(timestamp)).toBe("Jun 21, 20:07");
  });

  it("formats older messages with short date and time", () => {
    vi.useFakeTimers();
    const now = new Date(2026, 5, 28, 21, 30);
    vi.setSystemTime(now);
    setCurrentAgentGuiI18nLocaleForTests("en");

    const timestamp = new Date(2026, 4, 12, 9, 5).getTime();

    expect(formatAgentMessageTimestamp(timestamp)).toBe("May 12, 09:05");
  });

  it("formats Chinese current-week timestamps with readable spacing", () => {
    vi.useFakeTimers();
    const now = new Date(2026, 5, 28, 21, 30);
    vi.setSystemTime(now);
    setCurrentAgentGuiI18nLocaleForTests("zh-CN");

    const timestamp = new Date(2026, 5, 28, 20, 7).getTime();

    expect(formatAgentMessageTimestamp(timestamp)).toBe("星期日 20:07");
  });

  it("formats Chinese older timestamps through the existing short formatter", () => {
    vi.useFakeTimers();
    const now = new Date(2026, 5, 28, 21, 30);
    vi.setSystemTime(now);
    setCurrentAgentGuiI18nLocaleForTests("zh-CN");

    const timestamp = new Date(2026, 5, 21, 20, 7).getTime();

    expect(formatAgentMessageTimestamp(timestamp)).toBe("6/21 20:07");
  });

  it("returns null for empty or non-finite timestamps", () => {
    expect(formatAgentMessageTimestamp(null)).toBeNull();
    expect(formatAgentMessageTimestamp(undefined)).toBeNull();
    expect(formatAgentMessageTimestamp(Number.NaN)).toBeNull();
    expect(formatAgentMessageTimestamp(Number.POSITIVE_INFINITY)).toBeNull();
  });
});
