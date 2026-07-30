export function resolveDesktopAgentGUIWorkbenchBodyVisibility(input: {
  isPresentationVisible?: boolean;
  isVisible: boolean;
  isVisuallyExposed: boolean;
}): boolean {
  return (
    input.isPresentationVisible === true ||
    (input.isVisible && input.isVisuallyExposed)
  );
}
