import { describe, expect, it } from "vitest";
import {
  normalizePermissionModeSelection,
  permissionModeSelectionPatch,
  resolvePermissionModeControlsDisabled,
  shouldRetrySessionSettingsUpdate
} from "./composerModeSelection";

describe("normalizePermissionModeSelection", () => {
  it("rejects transient empty select values instead of clearing permission", () => {
    expect(normalizePermissionModeSelection("")).toBeNull();
    expect(normalizePermissionModeSelection("   ")).toBeNull();
  });

  it("normalizes a real permission mode id", () => {
    expect(normalizePermissionModeSelection(" full-access ")).toBe(
      "full-access"
    );
  });
});

describe("permissionModeSelectionPatch", () => {
  it("clears plan mode for mutually-exclusive providers (claude-code)", () => {
    expect(
      permissionModeSelectionPatch("acceptEdits", { clearsPlanMode: true })
    ).toEqual({
      permissionModeId: "acceptEdits",
      planMode: false
    });
  });

  it("leaves plan mode intact for independent providers (codex)", () => {
    expect(
      permissionModeSelectionPatch("read-only", { clearsPlanMode: false })
    ).toEqual({
      permissionModeId: "read-only"
    });
  });
});

describe("resolvePermissionModeControlsDisabled", () => {
  it("stays disabled while a turn is actively running", () => {
    expect(
      resolvePermissionModeControlsDisabled({
        isSendingTurn: true,
        isSubmittingPrompt: false,
        showStopButton: true
      })
    ).toBe(true);
  });

  it("blocks the brief prompt-submission race", () => {
    expect(
      resolvePermissionModeControlsDisabled({
        isSendingTurn: false,
        isSubmittingPrompt: true,
        showStopButton: false
      })
    ).toBe(true);
  });

  it("blocks waiting and interrupting turns represented by the stop control", () => {
    expect(
      resolvePermissionModeControlsDisabled({
        isSendingTurn: false,
        isSubmittingPrompt: false,
        showStopButton: true
      })
    ).toBe(true);
  });

  it("enables permission changes once no turn is in flight", () => {
    expect(
      resolvePermissionModeControlsDisabled({
        isSendingTurn: false,
        isSubmittingPrompt: false,
        showStopButton: false
      })
    ).toBe(false);
  });
});

describe("shouldRetrySessionSettingsUpdate", () => {
  it("treats a new user selection as an explicit retry after an unknown result", () => {
    expect(shouldRetrySessionSettingsUpdate("unknown")).toBe(true);
  });

  it.each([null, "idle", "inFlight", "failed"])(
    "does not mark %s as an uncertain retry",
    (status) => {
      expect(shouldRetrySessionSettingsUpdate(status)).toBe(false);
    }
  );
});
