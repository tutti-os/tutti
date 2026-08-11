import { describe, expect, it } from "vitest";
import {
  createComposerCommandPaletteState,
  isComposerCommandPaletteDismissed,
  reduceComposerCommandPaletteState
} from "./composerCommandPaletteState";

describe("composerCommandPaletteState", () => {
  it("reopens the command palette after slash is deleted and typed again", () => {
    let state = createComposerCommandPaletteState("");

    state = reduceComposerCommandPaletteState(state, {
      type: "draftChanged",
      prompt: "/"
    });
    expect(isComposerCommandPaletteDismissed(state)).toBe(false);

    state = reduceComposerCommandPaletteState(state, {
      type: "dismissCurrent"
    });
    expect(isComposerCommandPaletteDismissed(state)).toBe(true);

    state = reduceComposerCommandPaletteState(state, {
      type: "draftChanged",
      prompt: ""
    });
    state = reduceComposerCommandPaletteState(state, {
      type: "draftChanged",
      prompt: "/"
    });

    expect(state.prompt).toBe("/");
    expect(isComposerCommandPaletteDismissed(state)).toBe(false);
  });

  it("keeps a programmatic command replacement dismissed", () => {
    const state = reduceComposerCommandPaletteState(
      createComposerCommandPaletteState("/browser"),
      {
        type: "replaceAndDismiss",
        prompt: ""
      }
    );

    expect(state.prompt).toBe("");
    expect(isComposerCommandPaletteDismissed(state)).toBe(true);
  });

  it("does not carry a dismissal into an externally restored draft", () => {
    const dismissed = reduceComposerCommandPaletteState(
      createComposerCommandPaletteState("/"),
      { type: "dismissCurrent" }
    );
    const restored = reduceComposerCommandPaletteState(dismissed, {
      type: "reset",
      prompt: "/"
    });

    expect(restored.prompt).toBe("/");
    expect(isComposerCommandPaletteDismissed(restored)).toBe(false);
  });
});
