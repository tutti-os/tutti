import { NativeListRow, NativeSheet } from "@tutti-os/ui-system/native";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { Modal, TextInput } from "react-native";
import type { AgentActivitySessionSettings } from "@tutti-os/agent-activity-core";
import type { WorkspaceActivitySnapshot } from "../services/workspaceActivityService";
import { MobileComposerDock } from "./MobileComposerDock";

test("rejects stale overlay close callbacks across ABA activations", () => {
  let renderer: ReactTestRenderer;
  act(() => {
    renderer = create(composerDock(createModel()));
  });

  press(renderer!, "mobile-composer-model-settings");
  expect(visibleModals(renderer!)).toEqual([true, false]);
  const closeSettingsA =
    renderer!.root.findByType(NativeSheet).props.onOpenChange;

  press(renderer!, "mobile-composer-tools");
  expect(visibleModals(renderer!)).toEqual([false, true]);
  const closeToolsA =
    renderer!.root.findAllByType(Modal)[1]?.props.onRequestClose;

  press(renderer!, "mobile-composer-model-settings");
  expect(visibleModals(renderer!)).toEqual([true, false]);

  act(() => closeSettingsA(false));
  expect(visibleModals(renderer!)).toEqual([true, false]);

  press(renderer!, "mobile-composer-tools");
  expect(visibleModals(renderer!)).toEqual([false, true]);

  act(() => closeToolsA());
  expect(visibleModals(renderer!)).toEqual([false, true]);

  act(() => renderer!.root.findAllByType(Modal)[1]?.props.onRequestClose());
  expect(visibleModals(renderer!)).toEqual([false, false]);
});

test("keeps the draft visible but disables editing and actions while unavailable", () => {
  let renderer: ReactTestRenderer;
  act(() => {
    renderer = create(
      composerDock({
        ...createModel(),
        commandsAvailable: false,
        draft: "keep this draft"
      })
    );
  });

  expect(renderer!.root.findByType(TextInput).props.editable).toBe(false);
  expect(testTargetIsDisabled(renderer!, "mobile-composer-tools")).toBe(true);
  expect(
    testTargetIsDisabled(renderer!, "mobile-composer-model-settings")
  ).toBe(true);
});

test("closes settings and rejects a queued selection when commands become unavailable", () => {
  const updates: AgentActivitySessionSettings[] = [];
  let renderer: ReactTestRenderer;
  act(() => {
    renderer = create(
      composerDock(createModel(), (settings) => updates.push(settings))
    );
  });

  press(renderer!, "mobile-composer-model-settings");
  const queuedSelection = renderer!.root.find(
    (node) =>
      node.type === NativeListRow &&
      node.props.title === "Test model" &&
      typeof node.props.onPress === "function"
  ).props.onPress;

  act(() => {
    renderer!.update(
      composerDock({ ...createModel(), commandsAvailable: false }, (settings) =>
        updates.push(settings)
      )
    );
  });
  expect(visibleModals(renderer!)).toEqual([false, false]);

  act(() => queuedSelection());
  expect(updates).toEqual([]);
});

function press(renderer: ReactTestRenderer, testID: string): void {
  const target = renderer.root.find(
    (node) =>
      node.props.testID === testID && typeof node.props.onPress === "function"
  );
  act(() => target.props.onPress());
}

function visibleModals(renderer: ReactTestRenderer): boolean[] {
  return renderer.root
    .findAllByType(Modal)
    .map((modal) => modal.props.visible === true);
}

function testTargetIsDisabled(
  renderer: ReactTestRenderer,
  testID: string
): boolean {
  const targets = renderer.root.findAll((node) => node.props.testID === testID);
  return targets.some((target) => target.props.disabled === true);
}

function composerDock(
  model: WorkspaceActivitySnapshot,
  onUpdate: (settings: AgentActivitySessionSettings) => void = () => undefined
) {
  return (
    <MobileComposerDock
      model={model}
      onDraftChange={() => undefined}
      onRefreshQuickPrompts={() => Promise.resolve()}
      onSend={() => undefined}
      onStop={() => undefined}
      onUpdate={onUpdate}
      quickPromptLibrary={{
        enabled: false,
        errorCode: null,
        prompts: [],
        status: "ready"
      }}
    />
  );
}

function createModel(): WorkspaceActivitySnapshot {
  return {
    activity: {
      presences: [],
      sessionMessagesById: {},
      sessions: [],
      workspaceId: "workspace"
    },
    ambiguousSubmission: false,
    composerOptions: {
      behavior: {
        collapseModelOptionsToLatest: false,
        modelOptionsAuthoritative: true,
        planModeExclusiveWithPermissionMode: false,
        prewarmDraftSession: false,
        refreshModelOptionsAfterSettings: false
      },
      capabilities: null,
      loadedAtUnixMs: 0,
      models: [{ label: "Test model", value: "test-model" }],
      modelConfigurable: true,
      provider: "test",
      reasoningEfforts: [],
      skills: [],
      speeds: []
    },
    composerOptionsLoadStatus: "ready",
    composerSettings: { model: "test-model" },
    composerSettingsSupport: {
      browser: false,
      computer: false,
      model: true,
      modelSwitch: true,
      permission: false,
      permissionModeChangeDeferred: false,
      permissionModeChangeDuringTurn: false,
      plan: false,
      planImplementation: false,
      reasoning: false,
      speed: false
    },
    commandsAvailable: true,
    conversation: null,
    creating: false,
    draft: "",
    errorCode: null,
    interactionStates: {},
    loading: false,
    pendingInteractions: [],
    pinningSessionIds: [],
    railErrorCode: null,
    railSections: [],
    railStatus: "ready",
    selectedAgentSessionId: null,
    selectedAgentTargetId: null,
    selectedSession: null,
    sending: false,
    targets: []
  };
}
