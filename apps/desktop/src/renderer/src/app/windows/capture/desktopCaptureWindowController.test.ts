import assert from "node:assert/strict";
import test from "node:test";
import type { AgentActivityComposerOptions } from "@tutti-os/agent-activity-core";
import type {
  DesktopCaptureApi,
  DesktopCaptureComposerOptionsInput,
  DesktopCaptureRememberComposerDefaultsInput,
  DesktopCaptureSelectionResult,
  DesktopCaptureSubmitInput
} from "../../../../../shared/contracts/capture.ts";
import {
  DesktopCaptureWindowController,
  prependCapturePromptInstruction
} from "./desktopCaptureWindowController.ts";

function composerOptionsFixture(input: {
  imageInput?: boolean;
  effectiveModel?: string;
}): AgentActivityComposerOptions {
  return {
    provider: "codex",
    capabilities: {
      imageInput: input.imageInput ?? true,
      modelImageInputRequired: false,
      modelPlanBinding: false,
      skills: false,
      compact: false,
      tokenUsage: false,
      rateLimits: false,
      planMode: false,
      interrupt: false,
      modelSwitch: false,
      activeTurnGuidance: false,
      browserUse: false,
      computerUse: false,
      goalPause: false,
      planImplementation: false,
      permissionModeChangeDuringTurn: false,
      permissionModeChangeDeferred: false,
      review: false,
      resumeRunningTurn: false
    },
    models: [],
    reasoningEfforts: [],
    speeds: [],
    skills: [],
    behavior: {
      collapseModelOptionsToLatest: false,
      modelOptionsAuthoritative: true,
      refreshModelOptionsAfterSettings: true,
      prewarmDraftSession: false,
      planModeExclusiveWithPermissionMode: false
    },
    ...(input.effectiveModel
      ? { effectiveSettings: { model: input.effectiveModel } }
      : {}),
    loadedAtUnixMs: 1
  };
}

function agentFixture(input: {
  id?: string;
  imageInput?: boolean;
  composerOptions?: AgentActivityComposerOptions | null;
}) {
  return {
    capabilities: {
      imageInput: input.imageInput ?? true,
      workspaceReferences: true
    },
    composerOptions: input.composerOptions ?? null,
    iconUrl: "data:image/png;base64,aWNvbg==",
    id: input.id ?? "agent-1",
    name: "Agent",
    provider: "codex"
  };
}

const attachmentFixture = {
  dataBase64: "cG5n",
  dataUrl: "data:image/png;base64,cG5n",
  displayName: "capture.png",
  height: 80,
  mimeType: "image/png" as const,
  width: 100
};

const captureStateFixture = {
  agents: [],
  displayHeight: 800,
  displayWidth: 1200,
  locale: "en" as const,
  screenshotDataUrl: "data:image/png;base64,c2NyZWVu",
  themeAppearance: "light" as const,
  workspaceId: "workspace-1"
};

async function settled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function createUserProjectsApi(): DesktopCaptureApi["userProjects"] {
  return {
    list: async () => ({ projects: [] }),
    prepareSelection: async () => ({
      isSelectedPathMissing: false,
      projects: [],
      selection: { kind: "none" }
    }),
    use: async ({ path }) => ({
      id: path,
      label: path,
      path,
      pinnedAtUnixMs: 0
    })
  };
}

test("coalesces repeated selection gestures while the first selection is loading", async () => {
  let resolveSelection!: (result: DesktopCaptureSelectionResult) => void;
  const pendingSelection = new Promise<DesktopCaptureSelectionResult>(
    (resolve) => {
      resolveSelection = resolve;
    }
  );
  let selectionCalls = 0;
  const api: DesktopCaptureApi = {
    cancel: async () => undefined,
    getComposerOptions: async () => ({
      agents: [agentFixture({ composerOptions: composerOptionsFixture({}) })]
    }),
    getState: async () => captureStateFixture,
    queryMentionDirectory: async () => [],
    queryMentions: async () => [],
    rememberComposerDefaults: async () => undefined,
    resolveMention: async () => null,
    select: () => {
      selectionCalls += 1;
      return pendingSelection;
    },
    selectFiles: async () => [],
    selectProjectDirectory: async () => null,
    submit: async () => ({ agentSessionId: "session-1" }),
    userProjects: createUserProjectsApi()
  };
  const controller = new DesktopCaptureWindowController(api);
  await controller.initialize();
  controller.beginSelection({ x: 10, y: 20 });
  controller.updateSelection({ x: 110, y: 100 });

  const first = controller.finishSelection();
  assert.equal(controller.getSnapshot().selectionPending, true);
  assert.equal(controller.getSnapshot().stage, "preparing");
  controller.beginSelection({ x: 200, y: 200 });
  controller.updateSelection({ x: 300, y: 300 });
  const second = controller.finishSelection();

  assert.equal(first, second);
  assert.equal(selectionCalls, 1);
  assert.deepEqual(controller.getSnapshot().selection, {
    height: 80,
    width: 100,
    x: 10,
    y: 20
  });

  resolveSelection({
    agents: [agentFixture({})],
    attachment: attachmentFixture
  });
  assert.equal(await first, true);
  assert.equal(await second, true);
  assert.equal(controller.getSnapshot().selectionPending, false);
  assert.equal(controller.getSnapshot().stage, "composing");
  assert.equal(await controller.finishSelection(), false);
  assert.equal(selectionCalls, 1);
});

test("DesktopCaptureWindowController owns selection and submission retry state", async () => {
  const composerOptionInputs: DesktopCaptureComposerOptionsInput[] = [];
  const rememberedDefaults: DesktopCaptureRememberComposerDefaultsInput[] = [];
  const submissions: DesktopCaptureSubmitInput[] = [];
  let failSubmission = true;
  const api: DesktopCaptureApi = {
    cancel: async () => undefined,
    getComposerOptions: async (input) => {
      composerOptionInputs.push(input);
      return {
        agents: [agentFixture({ composerOptions: composerOptionsFixture({}) })]
      };
    },
    getState: async () => captureStateFixture,
    queryMentionDirectory: async () => [],
    queryMentions: async () => [],
    rememberComposerDefaults: async (input) => {
      rememberedDefaults.push(input);
    },
    resolveMention: async () => null,
    select: async () => ({
      agents: [agentFixture({})],
      attachment: attachmentFixture
    }),
    selectFiles: async () => [],
    selectProjectDirectory: async () => ({ path: "/workspace/alpha" }),
    submit: async (input) => {
      submissions.push(input);
      if (failSubmission) {
        failSubmission = false;
        throw new Error("run unavailable");
      }
      return { agentSessionId: "session-1" };
    },
    userProjects: createUserProjectsApi()
  };
  const controller = new DesktopCaptureWindowController(api);
  await controller.initialize();
  assert.equal(controller.getSnapshot().stage, "selecting");

  controller.beginSelection({ x: 10, y: 20 });
  controller.updateSelection({ x: 110, y: 100 });
  assert.equal(await controller.finishSelection(), true);
  assert.equal(controller.getSnapshot().stage, "composing");
  controller.setContent([
    { text: "Fix the selected bug", type: "text" },
    ...controller.getSnapshot().content.filter((block) => block.type !== "text")
  ]);
  controller.setTrackWithTask(true);
  controller.setComposerSettings({
    model: "gpt-5.6-sol",
    reasoningEffort: "high"
  });
  await controller.setProjectPath(
    (await controller.userProjectApi.selectDirectory?.())?.path ?? null
  );
  await settled();

  await controller.submit(
    "agent-1",
    undefined,
    "Fix the selected bug",
    "Create a Task, start the work, and keep the Task updated"
  );
  assert.equal(controller.getSnapshot().failed, true);
  assert.equal(controller.getSnapshot().submitting, false);
  await controller.submit(
    "agent-stale",
    undefined,
    "Fix the selected bug",
    "Create a Task, start the work, and keep the Task updated"
  );
  assert.equal(submissions.length, 1);
  await controller.submit(
    "agent-1",
    undefined,
    "Fix the selected bug",
    "Create a Task, start the work, and keep the Task updated"
  );
  assert.equal(submissions.length, 2);
  assert.deepEqual(submissions[1], {
    agentTargetId: "agent-1",
    content: [
      {
        text: "Create a Task, start the work, and keep the Task updated\n\nFix the selected bug",
        type: "text"
      },
      {
        data: "cG5n",
        mimeType: "image/png",
        name: "capture.png",
        type: "image"
      }
    ],
    cwd: "/workspace/alpha",
    displayPrompt: "Fix the selected bug",
    settings: {
      model: "gpt-5.6-sol",
      reasoningEffort: "high"
    }
  });
  assert.deepEqual(composerOptionInputs.at(-1), {
    agentTargetId: "agent-1",
    cwd: "/workspace/alpha",
    settings: {
      model: "gpt-5.6-sol",
      reasoningEffort: "high"
    }
  });
  // Explicit picks land in the canonical per-target defaults ledger.
  assert.deepEqual(rememberedDefaults.at(-1), {
    agentTargetId: "agent-1",
    defaults: { model: "gpt-5.6-sol", reasoningEffort: "high" }
  });
  const visibleText = controller.getSnapshot().content[0];
  assert.equal(
    visibleText?.type === "text" ? visibleText.text : null,
    "Fix the selected bug"
  );
});

test("submission carries the displayed effective settings even without picks", async () => {
  // The mismatch regression: an untouched panel used to submit no settings at
  // all, letting the daemon seed a model the panel never displayed. The
  // resolved (displayed) settings must ride along explicitly.
  const submissions: DesktopCaptureSubmitInput[] = [];
  const api: DesktopCaptureApi = {
    cancel: async () => undefined,
    getComposerOptions: async () => ({
      agents: [
        agentFixture({
          composerOptions: composerOptionsFixture({
            effectiveModel: "gpt-5.6-sol"
          })
        })
      ]
    }),
    getState: async () => captureStateFixture,
    queryMentionDirectory: async () => [],
    queryMentions: async () => [],
    rememberComposerDefaults: async () => undefined,
    resolveMention: async () => null,
    select: async () => ({
      agents: [agentFixture({})],
      attachment: attachmentFixture
    }),
    selectFiles: async () => [],
    selectProjectDirectory: async () => null,
    submit: async (input) => {
      submissions.push(input);
      return { agentSessionId: "session-1" };
    },
    userProjects: createUserProjectsApi()
  };
  const controller = new DesktopCaptureWindowController(api);
  await controller.initialize();
  controller.beginSelection({ x: 10, y: 20 });
  controller.updateSelection({ x: 110, y: 100 });
  assert.equal(await controller.finishSelection(), true);
  await settled();

  await controller.submit("agent-1");
  assert.equal(submissions.length, 1);
  assert.deepEqual(submissions[0]?.settings, { model: "gpt-5.6-sol" });
});

test("prependCapturePromptInstruction adds an instruction without mutating image-only content", () => {
  const content = [
    {
      data: "cG5n",
      mimeType: "image/png",
      name: "capture.png",
      type: "image" as const
    }
  ];
  assert.deepEqual(
    prependCapturePromptInstruction(content, "Create and track the Task"),
    [{ text: "Create and track the Task", type: "text" }, content[0]]
  );
  assert.deepEqual(content, [
    {
      data: "cG5n",
      mimeType: "image/png",
      name: "capture.png",
      type: "image"
    }
  ]);
});

test("DesktopCaptureWindowController restores and remembers an available Agent Target", async () => {
  const writes: Array<{ agentTargetId: string; workspaceId: string }> = [];
  const agents = [
    agentFixture({ id: "agent-codex" }),
    agentFixture({ id: "agent-tutti" })
  ];
  const api: DesktopCaptureApi = {
    cancel: async () => undefined,
    getComposerOptions: async ({ agentTargetId }) => ({
      agents: agents
        .filter((agent) => agent.id === agentTargetId)
        .map((agent) => ({
          ...agent,
          composerOptions: composerOptionsFixture({})
        }))
    }),
    getState: async () => captureStateFixture,
    queryMentionDirectory: async () => [],
    queryMentions: async () => [],
    rememberComposerDefaults: async () => undefined,
    resolveMention: async () => null,
    select: async () => ({
      agents,
      attachment: attachmentFixture
    }),
    selectFiles: async () => [],
    selectProjectDirectory: async () => null,
    submit: async () => ({ agentSessionId: "session-1" }),
    userProjects: createUserProjectsApi()
  };
  const controller = new DesktopCaptureWindowController(api, {
    read: () => "agent-tutti",
    write: (workspaceId, agentTargetId) =>
      writes.push({ agentTargetId, workspaceId })
  });

  await controller.initialize();
  controller.beginSelection({ x: 10, y: 20 });
  controller.updateSelection({ x: 110, y: 100 });
  assert.equal(await controller.finishSelection(), true);
  assert.equal(controller.getSnapshot().agentTargetId, "agent-tutti");

  controller.setAgentTargetId("agent-codex");
  assert.equal(controller.getSnapshot().agentTargetId, "agent-codex");
  assert.deepEqual(writes, [
    { agentTargetId: "agent-codex", workspaceId: "workspace-1" }
  ]);
});

test("DesktopCaptureWindowController refreshes only the selected Agent capability for the selected project", async () => {
  const composerCwds: Array<string | null | undefined> = [];
  const composerAgentTargetIds: string[] = [];
  const submissions: DesktopCaptureSubmitInput[] = [];
  const api: DesktopCaptureApi = {
    cancel: async () => undefined,
    getComposerOptions: async ({ agentTargetId, cwd }) => {
      composerAgentTargetIds.push(agentTargetId);
      composerCwds.push(cwd);
      return {
        agents: [
          agentFixture({
            imageInput: cwd === "/workspace/vision",
            composerOptions: composerOptionsFixture({
              imageInput: cwd === "/workspace/vision"
            })
          })
        ]
      };
    },
    getState: async () => captureStateFixture,
    queryMentionDirectory: async () => [],
    queryMentions: async () => [],
    rememberComposerDefaults: async () => undefined,
    resolveMention: async () => null,
    select: async () => ({
      agents: [agentFixture({})],
      attachment: attachmentFixture
    }),
    selectFiles: async () => [],
    selectProjectDirectory: async () => null,
    submit: async (input) => {
      submissions.push(input);
      return { agentSessionId: "session-1" };
    },
    userProjects: createUserProjectsApi()
  };
  const controller = new DesktopCaptureWindowController(api);
  await controller.initialize();
  controller.beginSelection({ x: 10, y: 20 });
  controller.updateSelection({ x: 110, y: 100 });
  assert.equal(await controller.finishSelection(), true);

  await controller.setProjectPath("/workspace/text-only");
  await settled();
  assert.equal(
    controller.getSnapshot().capture?.agents[0]?.capabilities.imageInput,
    false
  );
  await controller.submit("agent-1");
  assert.equal(submissions.length, 0);

  await controller.setProjectPath("/workspace/vision");
  await settled();
  assert.equal(
    controller.getSnapshot().capture?.agents[0]?.capabilities.imageInput,
    true
  );
  await controller.submit("agent-1");
  assert.equal(submissions.length, 1);
  assert.deepEqual(composerAgentTargetIds, ["agent-1", "agent-1", "agent-1"]);
  assert.deepEqual(composerCwds, [
    null,
    "/workspace/text-only",
    "/workspace/vision"
  ]);
});

test("DesktopCaptureWindowController discards an older project capability response", async () => {
  const deferred = new Map<string, (imageInput: boolean) => void>();
  const api: DesktopCaptureApi = {
    cancel: async () => undefined,
    getComposerOptions: ({ cwd }) => {
      if (!cwd) {
        return Promise.resolve({
          agents: [
            agentFixture({ composerOptions: composerOptionsFixture({}) })
          ]
        });
      }
      return new Promise((resolve) => {
        deferred.set(cwd, (imageInput) =>
          resolve({
            agents: [
              agentFixture({
                imageInput,
                composerOptions: composerOptionsFixture({ imageInput })
              })
            ]
          })
        );
      });
    },
    getState: async () => captureStateFixture,
    queryMentionDirectory: async () => [],
    queryMentions: async () => [],
    rememberComposerDefaults: async () => undefined,
    resolveMention: async () => null,
    select: async () => ({
      agents: [agentFixture({})],
      attachment: attachmentFixture
    }),
    selectFiles: async () => [],
    selectProjectDirectory: async () => null,
    submit: async () => ({ agentSessionId: "session-1" }),
    userProjects: createUserProjectsApi()
  };
  const controller = new DesktopCaptureWindowController(api);
  await controller.initialize();
  controller.beginSelection({ x: 10, y: 20 });
  controller.updateSelection({ x: 110, y: 100 });
  assert.equal(await controller.finishSelection(), true);

  const older = controller.setProjectPath("/workspace/older");
  const newer = controller.setProjectPath("/workspace/newer");
  deferred.get("/workspace/newer")?.(true);
  await newer;
  await settled();
  deferred.get("/workspace/older")?.(false);
  await older;
  await settled();

  assert.equal(controller.getSnapshot().projectPath, "/workspace/newer");
  assert.equal(
    controller.getSnapshot().capture?.agents[0]?.capabilities.imageInput,
    true
  );
});

test("a failed options refresh keeps the last good menu and capabilities", async () => {
  let failRefresh = false;
  const api: DesktopCaptureApi = {
    cancel: async () => undefined,
    getComposerOptions: async () => {
      if (failRefresh) {
        throw new Error("catalog probe timed out");
      }
      return {
        agents: [agentFixture({ composerOptions: composerOptionsFixture({}) })]
      };
    },
    getState: async () => captureStateFixture,
    queryMentionDirectory: async () => [],
    queryMentions: async () => [],
    rememberComposerDefaults: async () => undefined,
    resolveMention: async () => null,
    select: async () => ({
      agents: [agentFixture({})],
      attachment: attachmentFixture
    }),
    selectFiles: async () => [],
    selectProjectDirectory: async () => null,
    submit: async () => ({ agentSessionId: "session-1" }),
    userProjects: createUserProjectsApi()
  };
  const controller = new DesktopCaptureWindowController(api);
  await controller.initialize();
  controller.beginSelection({ x: 10, y: 20 });
  controller.updateSelection({ x: 110, y: 100 });
  assert.equal(await controller.finishSelection(), true);
  await settled();
  const loaded = controller.getSnapshot().capture?.agents[0];
  assert.equal(loaded?.capabilities.imageInput, true);
  assert.notEqual(loaded?.composerOptions, null);

  failRefresh = true;
  controller.setComposerSettings({ model: "gpt-5.6-sol" });
  await settled();
  const degraded = controller.getSnapshot();
  // Menu and capabilities stay on the last good options; composing stays
  // interactive and the failure is not fatal.
  assert.notEqual(degraded.capture?.agents[0]?.composerOptions, null);
  assert.equal(degraded.capture?.agents[0]?.capabilities.imageInput, true);
  assert.equal(degraded.refreshingAgentOptions, false);
  assert.equal(degraded.failed, false);
});
