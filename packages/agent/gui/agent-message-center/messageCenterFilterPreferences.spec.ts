import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  messageCenterFiltersStorageKey,
  readMessageCenterFilterPreferences,
  writeMessageCenterFilterPreferences
} from "./messageCenterFilterPreferences";

describe("messageCenterFilterPreferences", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  it("returns defaults when nothing is stored", () => {
    expect(readMessageCenterFilterPreferences()).toEqual({
      groupBy: "priority",
      statusFilters: null,
      providerFilters: null
    });
  });

  it("returns defaults when stored JSON is invalid", () => {
    window.localStorage.setItem(messageCenterFiltersStorageKey, "{not json");
    expect(readMessageCenterFilterPreferences().groupBy).toBe("priority");
  });

  it("round-trips groupBy and filter sets", () => {
    writeMessageCenterFilterPreferences({
      groupBy: "status",
      statusFilters: new Set(["waiting", "failed"]),
      providerFilters: new Set(["codex"])
    });
    const read = readMessageCenterFilterPreferences();
    expect(read.groupBy).toBe("status");
    expect(read.statusFilters).toEqual(new Set(["waiting", "failed"]));
    expect(read.providerFilters).toEqual(new Set(["codex"]));
  });

  it("preserves null filters (means all)", () => {
    writeMessageCenterFilterPreferences({
      groupBy: "time",
      statusFilters: null,
      providerFilters: null
    });
    const read = readMessageCenterFilterPreferences();
    expect(read.statusFilters).toBeNull();
    expect(read.providerFilters).toBeNull();
  });

  it("coerces an invalid groupBy back to priority", () => {
    window.localStorage.setItem(
      messageCenterFiltersStorageKey,
      JSON.stringify({ groupBy: "bogus" })
    );
    expect(readMessageCenterFilterPreferences().groupBy).toBe("priority");
  });

  it("drops unknown status filter members", () => {
    window.localStorage.setItem(
      messageCenterFiltersStorageKey,
      JSON.stringify({ statusFilters: ["waiting", "nope"] })
    );
    expect(readMessageCenterFilterPreferences().statusFilters).toEqual(
      new Set(["waiting"])
    );
  });
});
