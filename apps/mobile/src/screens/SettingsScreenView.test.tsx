import { NativeListRow, NativeSheet } from "@tutti-os/ui-system/native";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import {
  SettingsScreenView,
  shouldDismissThemeSheetSwipe
} from "./SettingsScreenView";
import type { MobileThemePreference } from "../services/mobileThemePreferenceService";

test("opens the theme sheet and presents the agreed option order", () => {
  let renderer: ReactTestRenderer;
  act(() => {
    renderer = create(settingsView());
  });

  expect(themeSheet(renderer!).props.open).toBe(false);
  act(() => themeRow(renderer!).props.onPress());
  expect(themeSheet(renderer!).props.open).toBe(true);

  const options = themeOptions(renderer!);
  expect(options.map((row) => row.props.title)).toEqual([
    "Match system",
    "Light",
    "Dark"
  ]);
  expect(options.map((row) => row.props.selected)).toEqual([
    true,
    false,
    false
  ]);
});

test("applies a selected theme and closes the sheet", () => {
  const selections: MobileThemePreference[] = [];
  let renderer: ReactTestRenderer;
  act(() => {
    renderer = create(
      settingsView((preference) => selections.push(preference))
    );
  });

  act(() => themeRow(renderer!).props.onPress());
  act(() => {
    themeOptions(renderer!)
      .find((row) => row.props.title === "Dark")
      ?.props.onPress();
  });

  expect(selections).toEqual(["dark"]);
  expect(themeSheet(renderer!).props.open).toBe(false);
});

test("dismisses the sheet without changing the theme", () => {
  const selections: MobileThemePreference[] = [];
  let renderer: ReactTestRenderer;
  act(() => {
    renderer = create(
      settingsView((preference) => selections.push(preference))
    );
  });

  act(() => themeRow(renderer!).props.onPress());
  act(() => themeSheet(renderer!).props.onOpenChange(false));

  expect(selections).toEqual([]);
  expect(themeSheet(renderer!).props.open).toBe(false);
});

test("uses the agreed downward-swipe threshold", () => {
  expect(shouldDismissThemeSheetSwipe(47)).toBe(false);
  expect(shouldDismissThemeSheetSwipe(48)).toBe(true);
});

test("makes software update a manual action", () => {
  let renderer: ReactTestRenderer;
  act(() => {
    renderer = create(settingsView());
  });

  const row = renderer!.root.find(
    (node) =>
      node.type === NativeListRow && node.props.title === "Software update"
  );
  expect(row.props.disabled).toBe(false);
  expect(row.props.onPress).toEqual(expect.any(Function));
  expect(row.props.description).toBe("Version 0.1.0");
});

function settingsView(
  onThemePreferenceChange: (preference: MobileThemePreference) => void = () =>
    undefined
) {
  return (
    <SettingsScreenView
      onBack={() => undefined}
      onSoftwareUpdatePress={() => undefined}
      onSignOut={() => undefined}
      onThemePreferenceChange={onThemePreferenceChange}
      session={{
        avatarURL: "",
        email: "user@example.com",
        name: "User",
        sessionId: "session-1",
        userId: "user-1"
      }}
      softwareUpdateDescription="Version 0.1.0"
      softwareUpdateDisabled={false}
      themePreference="system"
    />
  );
}

function themeRow(renderer: ReactTestRenderer) {
  return renderer.root.find(
    (node) => node.type === NativeListRow && node.props.title === "Theme"
  );
}

function themeOptions(renderer: ReactTestRenderer) {
  const titles = new Set(["Match system", "Light", "Dark"]);
  return renderer.root.findAll(
    (node) => node.type === NativeListRow && titles.has(node.props.title)
  );
}

function themeSheet(renderer: ReactTestRenderer) {
  return renderer.root.findByType(NativeSheet);
}
