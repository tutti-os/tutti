import { NativeButton } from "@tutti-os/ui-system/native";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { Text } from "react-native";
import { MobileConnectionRecoveryOverlay } from "./MobileConnectionRecoveryOverlay";

test("offers a software update instead of retrying incompatible revisions", () => {
  const checkForUpdates = jest.fn();
  const retry = jest.fn();
  let renderer: ReactTestRenderer;
  act(() => {
    renderer = create(
      <MobileConnectionRecoveryOverlay
        connection={{
          expectedRevision: "sha256:new",
          phase: "failed",
          reasonCode: "protocol_revision_mismatch",
          receivedRevision: "sha256:old",
          trigger: "initial_connect"
        }}
        onBackToDevices={() => undefined}
        onCheckForUpdates={checkForUpdates}
        onRetry={retry}
      />
    );
  });

  expect(
    renderer!.root.findAllByType(Text).map((node) => node.props.children)
  ).toEqual(
    expect.arrayContaining([
      "Computer and phone versions are incompatible",
      "Update Tutti on your phone or computer, then connect again."
    ])
  );
  const primary = renderer!.root.find(
    (node) => node.type === NativeButton && node.props.variant !== "secondary"
  );
  expect(primary.props.label).toBe("Check for updates");
  expect(
    renderer!.root.findAll(
      (node) => node.type === NativeButton && node.props.label === "Reconnect"
    )
  ).toHaveLength(0);

  act(() => primary.props.onPress());
  expect(checkForUpdates).toHaveBeenCalledTimes(1);
  expect(retry).not.toHaveBeenCalled();
});
