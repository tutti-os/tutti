import assert from "node:assert/strict";
import test from "node:test";
import {
  isExternalImportWizardBusy,
  shouldAllowExternalImportDialogOpenChange
} from "./externalAgentSessionImportWizardModel.ts";

test("wizard is not busy when idle", () => {
  assert.equal(
    isExternalImportWizardBusy({ importing: false, loading: false }),
    false
  );
});

test("wizard is busy while scanning", () => {
  assert.equal(
    isExternalImportWizardBusy({ importing: false, loading: true }),
    true
  );
});

test("wizard is busy while importing", () => {
  assert.equal(
    isExternalImportWizardBusy({ importing: true, loading: false }),
    true
  );
});

test("blocks the X close button (onOpenChange(false)) while importing", () => {
  assert.equal(
    shouldAllowExternalImportDialogOpenChange({
      importing: true,
      loading: false,
      nextOpen: false
    }),
    false
  );
});

test("blocks the X close button (onOpenChange(false)) while scanning", () => {
  assert.equal(
    shouldAllowExternalImportDialogOpenChange({
      importing: false,
      loading: true,
      nextOpen: false
    }),
    false
  );
});

test("allows the X close button (onOpenChange(false)) when idle", () => {
  assert.equal(
    shouldAllowExternalImportDialogOpenChange({
      importing: false,
      loading: false,
      nextOpen: false
    }),
    true
  );
});

test("allows the X close button once importing finishes and a result is shown", () => {
  // handleImport's finally block clears `importing` before/along with
  // setResult, so by the time the result screen is visible the wizard is
  // idle again and dismissal must not be trapped.
  assert.equal(
    shouldAllowExternalImportDialogOpenChange({
      importing: false,
      loading: false,
      nextOpen: false
    }),
    true
  );
});

test("never blocks opening the dialog, even if somehow called while busy", () => {
  assert.equal(
    shouldAllowExternalImportDialogOpenChange({
      importing: true,
      loading: true,
      nextOpen: true
    }),
    true
  );
});
