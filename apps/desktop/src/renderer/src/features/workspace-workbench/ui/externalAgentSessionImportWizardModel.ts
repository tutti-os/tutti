// Pure decision logic for ExternalAgentSessionImportWizard.tsx, split out so
// it can be unit tested without mounting the dialog (this app's test runner
// is plain node:test over *.test.ts and has no React rendering harness).

/**
 * The import wizard is "busy" whenever a scan or import request is in
 * flight. Dismissing the dialog does not cancel that request (there is no
 * AbortController wired up; the backend keeps running to completion either
 * way), but a disappearing dialog reads as "the import stopped". All three
 * ways a Radix Dialog can be dismissed - Escape, click-outside, and the
 * built-in "X" close button - must agree on this single condition so none
 * of them can slip through while busy.
 */
export function isExternalImportWizardBusy({
  importing,
  loading
}: {
  importing: boolean;
  loading: boolean;
}): boolean {
  return loading || importing;
}

/**
 * Decides whether a Dialog onOpenChange(nextOpen) call should be allowed
 * through. Only closes (nextOpen === false) are ever blocked, and only
 * while busy; opening, and any change once idle, is always allowed.
 */
export function shouldAllowExternalImportDialogOpenChange({
  importing,
  loading,
  nextOpen
}: {
  importing: boolean;
  loading: boolean;
  nextOpen: boolean;
}): boolean {
  if (nextOpen) {
    return true;
  }
  return !isExternalImportWizardBusy({ importing, loading });
}
