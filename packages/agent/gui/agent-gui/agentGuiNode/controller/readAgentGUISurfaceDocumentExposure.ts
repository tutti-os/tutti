/**
 * Reads whether this renderer document is both visible and focused. Host node
 * focus/visibility is not enough: a Workbench node can remain focused in host
 * state while the OS window or browser document is backgrounded.
 */
export function readAgentGUISurfaceDocumentExposure(): boolean {
  return (
    typeof document === "undefined" ||
    (document.visibilityState === "visible" && document.hasFocus())
  );
}
