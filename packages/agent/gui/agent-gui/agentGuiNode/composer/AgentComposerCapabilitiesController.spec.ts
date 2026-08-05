import { describe, expect, it, vi } from "vitest";
import type {
  AgentHostComposerCapabilitiesApi,
  AgentHostComposerCapabilitiesSnapshot
} from "../../../host/agentHostApi";
import type { AgentGuiScheduler } from "../agentGuiScheduler";
import {
  createAgentComposerCapabilitiesController,
  selectAgentComposerCapabilitiesSnapshot,
  type AgentComposerCapabilitiesScope
} from "./AgentComposerCapabilitiesController";

const PARTIAL: AgentHostComposerCapabilitiesSnapshot = {
  capabilities: [],
  hiddenSlashSkillEntryIds: [],
  partial: true
};
const READY: AgentHostComposerCapabilitiesSnapshot = {
  capabilities: [],
  hiddenSlashSkillEntryIds: ["sites-entry"],
  partial: false
};
const SCOPE = scope("scope-a");

describe("AgentComposerCapabilitiesController", () => {
  it("preloads a scope snapshot and refreshes on a later palette open", async () => {
    const source = createSource(
      vi.fn<AgentHostComposerCapabilitiesApi["list"]>().mockResolvedValue(READY)
    );
    const controller = createAgentComposerCapabilitiesController({ source });

    controller.sync({ active: false, scope: SCOPE });
    await settle();
    expect(source.list).toHaveBeenCalledTimes(1);
    expect(select(controller, SCOPE)).toEqual(READY);

    controller.sync({ active: true, scope: SCOPE });
    await settle();
    expect(source.prime).toHaveBeenCalledTimes(2);
    expect(source.list).toHaveBeenCalledTimes(2);
  });

  it("retries a partial active snapshot through the scheduler", async () => {
    const list = vi
      .fn<AgentHostComposerCapabilitiesApi["list"]>()
      .mockResolvedValueOnce(PARTIAL)
      .mockResolvedValueOnce(READY);
    const scheduler = createScheduler();
    const controller = createAgentComposerCapabilitiesController({
      scheduler,
      source: createSource(list)
    });

    controller.sync({ active: true, scope: SCOPE });
    await settle();
    expect(select(controller, SCOPE)).toEqual(PARTIAL);
    expect(scheduler.tasks).toHaveLength(1);

    scheduler.tasks.shift()?.task();
    await settle();
    expect(select(controller, SCOPE)).toEqual(READY);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("fails open across an exact scope change and fences the old response", async () => {
    const first = deferred<AgentHostComposerCapabilitiesSnapshot>();
    const list = vi
      .fn<AgentHostComposerCapabilitiesApi["list"]>()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce(READY);
    const controller = createAgentComposerCapabilitiesController({
      source: createSource(list)
    });
    const nextScope = scope("scope-b");

    controller.sync({ active: false, scope: SCOPE });
    controller.sync({ active: false, scope: nextScope });
    expect(select(controller, nextScope)).toEqual(PARTIAL);
    await settle();
    expect(select(controller, nextScope)).toEqual(READY);

    first.resolve(PARTIAL);
    await settle();
    expect(select(controller, nextScope)).toEqual(READY);
  });

  it("restarts a mount prewarm after a subscription rebind", async () => {
    const source = createSource(
      vi.fn<AgentHostComposerCapabilitiesApi["list"]>().mockResolvedValue(READY)
    );
    const controller = createAgentComposerCapabilitiesController({ source });
    const unsubscribe = controller.subscribe(() => {});

    controller.sync({ active: false, scope: SCOPE });
    await settle();
    unsubscribe();
    const resubscribe = controller.subscribe(() => {});
    controller.sync({ active: false, scope: SCOPE });
    await settle();

    expect(source.list).toHaveBeenCalledTimes(2);
    expect(select(controller, SCOPE)).toEqual(READY);
    resubscribe();
  });
});

function scope(key: string): AgentComposerCapabilitiesScope {
  return {
    agentTargetId: "local:codex",
    authoritativeSkills: [],
    cwd: "/workspace",
    key,
    provider: "codex",
    supported: true
  };
}

function createSource(list: AgentHostComposerCapabilitiesApi["list"]) {
  return {
    isSupported: () => true,
    list,
    prime: vi.fn(async () => {})
  } satisfies AgentHostComposerCapabilitiesApi;
}

function createScheduler(): AgentGuiScheduler & {
  tasks: Array<{ cancelled: boolean; task: () => void }>;
} {
  const tasks: Array<{ cancelled: boolean; task: () => void }> = [];
  return {
    schedule: (_delay, task) => {
      const record = { cancelled: false, task };
      tasks.push(record);
      return {
        cancel: () => {
          record.cancelled = true;
        }
      };
    },
    tasks
  };
}

function select(
  controller: ReturnType<typeof createAgentComposerCapabilitiesController>,
  scope: AgentComposerCapabilitiesScope
): AgentHostComposerCapabilitiesSnapshot {
  return selectAgentComposerCapabilitiesSnapshot(
    controller.getSnapshot(),
    scope.key,
    scope.supported
  );
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
