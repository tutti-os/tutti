export interface ComposerCommandPaletteState {
  dismissedRevision: number | null;
  prompt: string;
  revision: number;
}

export type ComposerCommandPaletteAction =
  | { type: "dismissCurrent" }
  | { type: "draftChanged"; prompt: string }
  | { type: "replaceAndDismiss"; prompt: string }
  | { type: "reset"; prompt: string };

export function createComposerCommandPaletteState(
  prompt: string
): ComposerCommandPaletteState {
  return {
    dismissedRevision: null,
    prompt,
    revision: 0
  };
}

export function reduceComposerCommandPaletteState(
  state: ComposerCommandPaletteState,
  action: ComposerCommandPaletteAction
): ComposerCommandPaletteState {
  if (action.type === "dismissCurrent") {
    if (state.dismissedRevision === state.revision) {
      return state;
    }
    return { ...state, dismissedRevision: state.revision };
  }

  const revision = state.revision + 1;
  if (action.type === "replaceAndDismiss") {
    return {
      dismissedRevision: revision,
      prompt: action.prompt,
      revision
    };
  }
  return {
    dismissedRevision: null,
    prompt: action.prompt,
    revision
  };
}

export function isComposerCommandPaletteDismissed(
  state: ComposerCommandPaletteState
): boolean {
  return state.dismissedRevision === state.revision;
}
