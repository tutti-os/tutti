export interface AtPanelKeyboardActions {
  moveSelection: (delta: 1 | -1) => void;
  commitSelection: () => void;
  close: () => void;
  cycleFilter?: (delta: 1 | -1) => void;
}

export interface AtPanelKeyboardEventLike {
  key: string;
  shiftKey?: boolean;
  preventDefault: () => void;
}

export function makeAtPanelKeyDown(actions: AtPanelKeyboardActions) {
  return (event: AtPanelKeyboardEventLike): boolean => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      actions.moveSelection(1);
      return true;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      actions.moveSelection(-1);
      return true;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      actions.close();
      return true;
    }
    if (event.key === "Tab" && actions.cycleFilter) {
      event.preventDefault();
      actions.cycleFilter(event.shiftKey ? -1 : 1);
      return true;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      actions.commitSelection();
      return true;
    }
    return false;
  };
}

export function useAtPanelKeyboard(actions: AtPanelKeyboardActions) {
  return makeAtPanelKeyDown(actions);
}
