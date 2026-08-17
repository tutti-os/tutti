import { NativeButton, NativeProgressBar } from "@tutti-os/ui-system/native";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { MobileSoftwareUpdateOverlay } from "./MobileSoftwareUpdateOverlay";
import type { MobileUpdateSnapshot } from "../services/mobileUpdateService";

test("shows determinate download progress and supports cancellation", async () => {
  const cancel = jest.fn(async () => undefined);
  let renderer: ReactTestRenderer;
  act(() => {
    renderer = create(
      <MobileSoftwareUpdateOverlay
        onCancel={cancel}
        snapshot={snapshot("downloading", false, 512, 1024)}
      />
    );
  });

  expect(renderer!.root.findByType(NativeProgressBar).props.value).toBe(0.5);
  const button = renderer!.root.findByType(NativeButton);
  expect(button.props.label).toBe("Cancel update");
  await act(async () => button.props.onPress());
  expect(cancel).toHaveBeenCalledTimes(1);
});

test("uses indeterminate progress and hides cancel after opening installer", () => {
  let renderer: ReactTestRenderer;
  act(() => {
    renderer = create(
      <MobileSoftwareUpdateOverlay
        onCancel={async () => undefined}
        snapshot={snapshot("awaiting_install_confirmation", true, 1024, 1024)}
      />
    );
  });

  expect(renderer!.root.findByType(NativeProgressBar).props.value).toBeNull();
  expect(renderer!.root.findAllByType(NativeButton)).toHaveLength(0);
});

function snapshot(
  phase: NonNullable<MobileUpdateSnapshot["progress"]>["phase"],
  indeterminate: boolean,
  downloadedBytes: number,
  totalBytes: number
): MobileUpdateSnapshot {
  return {
    checkedAt: "2026-08-08T00:00:00.000Z",
    currentVersionCode: 1,
    currentVersionName: "0.1.0",
    installationFailureCode: null,
    progress: {
      downloadedBytes,
      errorCode: null,
      indeterminate,
      phase,
      totalBytes
    },
    release: {
      apkURL: "https://downloads.example.test/mobile.apk",
      mandatory: false,
      releasedAt: "2026-08-08T00:00:00.000Z",
      sha256: "a".repeat(64),
      sizeBytes: totalBytes,
      tag: "tutti-mobile-v0.1.1",
      versionCode: 2,
      versionName: "0.1.1"
    },
    status: "installing"
  };
}
