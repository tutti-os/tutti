import { NativeListRow, NativeSheet } from "@tutti-os/ui-system/native";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { Modal, TextInput } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
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

test("selects the new-session Agent and working directory above the composer", () => {
  const selectedTargets: string[] = [];
  const selectedProjects: Array<string | null> = [];
  let renderer: ReactTestRenderer;
  act(() => {
    renderer = create(
      composerDock(
        {
          ...createModel(),
          creating: true,
          targets: [createTarget()],
          userProjects: [createUserProject()]
        },
        () => undefined,
        {
          onSelectProject: (path) => selectedProjects.push(path),
          onSelectTarget: (id) => selectedTargets.push(id)
        }
      )
    );
  });

  press(renderer!, "mobile-composer-agent-select");
  act(() => {
    renderer!.root
      .find(
        (node) =>
          node.type === NativeListRow &&
          node.props.title === "Codex" &&
          typeof node.props.onPress === "function"
      )
      .props.onPress();
  });
  press(renderer!, "mobile-composer-directory-select");
  act(() => {
    renderer!.root
      .find(
        (node) =>
          node.type === NativeListRow &&
          node.props.title === "tutti" &&
          typeof node.props.onPress === "function"
      )
      .props.onPress();
  });

  expect(selectedTargets).toEqual(["target-1"]);
  expect(selectedProjects).toEqual(["/workspace/tutti"]);
});

test("shows platform-neutral overflow hints for the horizontal settings rail", () => {
  let renderer: ReactTestRenderer;
  act(() => {
    renderer = create(composerDock(createModel()));
  });
  const rail = renderer!.root.find(
    (node) => node.props.testID === "mobile-composer-settings-rail"
  );

  act(() => {
    rail.props.onLayout({ nativeEvent: { layout: { width: 180 } } });
    rail.props.onContentSizeChange(400, 40);
  });
  expect(
    renderer!.root.findAll(
      (node) => node.props.testID === "mobile-composer-settings-trailing-hint"
    ).length
  ).toBeGreaterThan(0);

  act(() => {
    rail.props.onScroll({ nativeEvent: { contentOffset: { x: 100 } } });
  });
  expect(
    renderer!.root.findAll(
      (node) => node.props.testID === "mobile-composer-settings-leading-hint"
    ).length
  ).toBeGreaterThan(0);
  expect(
    renderer!.root.findAll(
      (node) => node.props.testID === "mobile-composer-settings-trailing-hint"
    ).length
  ).toBeGreaterThan(0);

  act(() => {
    rail.props.onScroll({ nativeEvent: { contentOffset: { x: 220 } } });
  });
  expect(
    renderer!.root.findAll(
      (node) => node.props.testID === "mobile-composer-settings-trailing-hint"
    )
  ).toHaveLength(0);
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
  onUpdate: (settings: AgentActivitySessionSettings) => void = () => undefined,
  handlers: {
    onSelectProject?(path: string | null): void;
    onSelectTarget?(agentTargetId: string): void;
  } = {}
) {
  return (
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 800, width: 400, x: 0, y: 0 },
        insets: { bottom: 16, left: 0, right: 0, top: 24 }
      }}
    >
      <MobileComposerDock
        model={model}
        onDraftChange={() => undefined}
        onRefreshQuickPrompts={() => Promise.resolve()}
        onSelectProject={handlers.onSelectProject ?? (() => undefined)}
        onSelectTarget={handlers.onSelectTarget ?? (() => undefined)}
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
    </SafeAreaProvider>
  );
}

function createTarget() {
  return {
    availability: { status: "ready" as const },
    createdAtUnixMs: 1,
    enabled: true,
    id: "target-1",
    launchRef: { provider: "codex", type: "builtin_local" as const },
    name: "Codex",
    provider: "codex",
    sortOrder: 1,
    source: "system" as const,
    updatedAtUnixMs: 1
  };
}

function createUserProject() {
  return {
    createdAtUnixMs: 1,
    id: "project-1",
    label: "tutti",
    lastUsedAtUnixMs: 1,
    path: "/workspace/tutti",
    pinnedAtUnixMs: 0,
    sectionKey: "project:tutti",
    updatedAtUnixMs: 1
  };
}

function createModel(): WorkspaceActivitySnapshot {
  return {
    activity: {
      presences: [],
      sessionMessagesById: {},
      sessions: [],
      workspaceId: "workspace"
    },
    activityConversations: [],
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
    search: {
      failed: false,
      hasMore: false,
      loadingMore: false,
      pending: false,
      query: "",
      resolvedQuery: "",
      sessionIds: []
    },
    selectedAgentSessionId: null,
    selectedAgentTargetId: null,
    selectedProjectPath: null,
    selectedSession: null,
    sending: false,
    targets: [],
    userProjectErrorCode: null,
    userProjects: [],
    userProjectsStatus: "ready"
  };
}
