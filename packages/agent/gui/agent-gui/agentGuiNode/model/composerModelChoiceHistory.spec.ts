import { describe, expect, it } from "vitest";
import {
  MAX_RECENT_COMPOSER_MODELS,
  composerModelFavoritesStorageKey,
  composerModelRecentsStorageKey,
  parseComposerModelIdList,
  recordRecentComposerModel,
  serializeComposerModelIdList,
  toggleFavoriteComposerModel
} from "./composerModelChoiceHistory";

describe("composerModelChoiceHistory", () => {
  it("scopes storage keys per agent target with a default bucket", () => {
    expect(composerModelRecentsStorageKey("target-1")).toBe(
      "agent-gui:composer-model-recents:target-1"
    );
    expect(composerModelFavoritesStorageKey("target-1")).toBe(
      "agent-gui:composer-model-favorites:target-1"
    );
    expect(composerModelRecentsStorageKey("  ")).toBe(
      "agent-gui:composer-model-recents:default"
    );
    expect(composerModelFavoritesStorageKey(null)).toBe(
      "agent-gui:composer-model-favorites:default"
    );
  });

  it("round-trips id lists and drops malformed entries", () => {
    expect(parseComposerModelIdList(null)).toEqual([]);
    expect(parseComposerModelIdList("not json")).toEqual([]);
    expect(parseComposerModelIdList('{"a":1}')).toEqual([]);
    expect(parseComposerModelIdList('["m1", "", 3, "m1", " m2 "]')).toEqual([
      "m1",
      "m2"
    ]);
    expect(serializeComposerModelIdList(["m1", "m1", " m2 "])).toBe(
      '["m1","m2"]'
    );
  });

  it("records recents most-recent-first capped at five", () => {
    let recents: readonly string[] = [];
    for (const modelId of ["m1", "m2", "m3", "m4", "m5", "m6"]) {
      recents = recordRecentComposerModel(recents, modelId);
    }
    expect(recents).toEqual(["m6", "m5", "m4", "m3", "m2"]);
    expect(recents).toHaveLength(MAX_RECENT_COMPOSER_MODELS);

    // Re-picking an existing model moves it to the front without duplicates.
    expect(recordRecentComposerModel(recents, "m4")).toEqual([
      "m4",
      "m6",
      "m5",
      "m3",
      "m2"
    ]);
    // Blank picks leave the list untouched.
    expect(recordRecentComposerModel(recents, "  ")).toEqual(recents);
  });

  it("toggles favorites on and off", () => {
    const withFavorite = toggleFavoriteComposerModel([], "m1");
    expect(withFavorite).toEqual(["m1"]);
    expect(toggleFavoriteComposerModel(withFavorite, "m2")).toEqual([
      "m1",
      "m2"
    ]);
    expect(toggleFavoriteComposerModel(withFavorite, "m1")).toEqual([]);
    expect(toggleFavoriteComposerModel(withFavorite, " ")).toEqual(["m1"]);
  });
});
