import { describe, expect, it, vi } from "vitest";
import type { AgentActivityComposerOptions } from "@tutti-os/agent-activity-core";
import { ComposerSettingsCore } from "./composerSettingsCore.ts";
import type { ComposerSettingsDraft } from "./types.ts";

function options(
  overrides: Partial<AgentActivityComposerOptions> = {}
): AgentActivityComposerOptions {
  return {
    provider: "codex",
    capabilities: null,
    models: [
      { label: "GPT-5.6-Sol", value: "gpt-5.6-sol" },
      { label: "GPT-5.6-Terra", value: "gpt-5.6-terra" }
    ],
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
    effectiveSettings: { model: "gpt-5.6-terra", reasoningEffort: "high" },
    loadedAtUnixMs: 1,
    ...overrides
  };
}

interface DeferredFetch {
  input: {
    agentTargetId: string;
    cwd: string | null;
    settings: ComposerSettingsDraft | null;
  };
  resolve(value: AgentActivityComposerOptions): void;
  reject(error: Error): void;
}

function createHarness(
  rememberDefaults?: (id: string, patch: ComposerSettingsDraft) => Promise<void>
) {
  const fetches: DeferredFetch[] = [];
  const core = new ComposerSettingsCore(
    {
      fetchOptions: (input) =>
        new Promise((resolve, reject) => {
          fetches.push({ input, resolve, reject });
        }),
      ...(rememberDefaults ? { rememberDefaults } : {})
    },
    { agentTargetId: "local:codex", cwd: "/repo" }
  );
  return { core, fetches };
}

async function settled(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("ComposerSettingsCore", () => {
  it("fences out a slow settings-less response that lands after a newer pick", async () => {
    // The regression that motivated this core: the initial context load stalls
    // (slow catalog probe), the user picks a model meanwhile, and the stale
    // echo-free response must not overwrite the pick's options.
    const { core, fetches } = createHarness();
    core.refresh(); // initial context load, settings-less
    core.setSettings({ model: "gpt-5.6-sol" }); // newer, with settings
    expect(fetches).toHaveLength(2);
    expect(fetches[0]!.input.settings).toBeNull();
    expect(fetches[1]!.input.settings).toEqual({ model: "gpt-5.6-sol" });

    fetches[1]!.resolve(
      options({ effectiveSettings: { model: "gpt-5.6-sol" } })
    );
    await settled();
    expect(core.getSnapshot().resolvedSettings.model).toBe("gpt-5.6-sol");

    // Stale slow response lands last — must change nothing.
    fetches[0]!.resolve(
      options({ effectiveSettings: { model: "gpt-5.6-terra" } })
    );
    await settled();
    expect(core.getSnapshot().resolvedSettings.model).toBe("gpt-5.6-sol");
    expect(core.getSnapshot().refreshing).toBe(false);
  });

  it("keeps last good options and reports degraded on refresh failure", async () => {
    const { core, fetches } = createHarness();
    core.refresh();
    fetches[0]!.resolve(options());
    await settled();
    expect(core.getSnapshot().options).not.toBeNull();

    core.refresh();
    fetches[1]!.reject(new Error("catalog probe timed out"));
    await settled();
    const snapshot = core.getSnapshot();
    expect(snapshot.options).not.toBeNull();
    expect(snapshot.degraded).toBe(true);
    expect(snapshot.errorMessage).toBe("catalog probe timed out");

    core.refresh();
    fetches[2]!.resolve(options());
    await settled();
    expect(core.getSnapshot().degraded).toBe(false);
  });

  it("resolves display values from draft over effective settings", async () => {
    const { core, fetches } = createHarness();
    core.refresh();
    fetches[0]!.resolve(options());
    await settled();
    // No draft: effective settings win.
    expect(core.getSnapshot().resolvedSettings).toEqual({
      model: "gpt-5.6-terra",
      reasoningEffort: "high"
    });
    core.setSettings({ model: "gpt-5.6-sol" });
    expect(core.getSnapshot().resolvedSettings).toEqual({
      model: "gpt-5.6-sol",
      reasoningEffort: "high"
    });
    expect(core.resolveSubmitSettings()).toEqual(
      core.getSnapshot().resolvedSettings
    );
  });

  it("resets draft and options on target change but keeps draft on cwd change", async () => {
    const { core, fetches } = createHarness();
    core.refresh();
    fetches[0]!.resolve(options());
    await settled();
    core.setSettings({ model: "gpt-5.6-sol" });

    core.setContext({ agentTargetId: "local:codex", cwd: "/other" });
    expect(core.getSnapshot().draft).toEqual({ model: "gpt-5.6-sol" });
    expect(core.getSnapshot().options).not.toBeNull();

    core.setContext({ agentTargetId: "local:claude-code", cwd: "/other" });
    const snapshot = core.getSnapshot();
    expect(snapshot.draft).toEqual({});
    expect(snapshot.options).toBeNull();
    expect(snapshot.initialLoading).toBe(true);
    // The pending fetch for the old target must not seed the new target.
    fetches[fetches.length - 2]!.resolve(
      options({ effectiveSettings: { model: "gpt-5.6-sol" } })
    );
    await settled();
    expect(core.getSnapshot().options).toBeNull();
  });

  it("coalesces defaults writes to a single in-flight trailing patch", async () => {
    const writes: Array<{ id: string; patch: ComposerSettingsDraft }> = [];
    let release: (() => void) | null = null;
    const rememberDefaults = vi.fn(
      (id: string, patch: ComposerSettingsDraft) =>
        new Promise<void>((resolve) => {
          writes.push({ id, patch });
          release = resolve;
        })
    );
    const { core } = createHarness(rememberDefaults);
    core.setSettings({ model: "gpt-5.6-sol" });
    core.setSettings({ reasoningEffort: "high" });
    core.setSettings({ model: "gpt-5.6-terra" });
    await settled();
    // First write in flight with the first patch; later picks coalesced.
    expect(writes).toHaveLength(1);
    release!();
    await settled();
    expect(writes).toHaveLength(2);
    expect(writes[1]).toEqual({
      id: "local:codex",
      patch: { model: "gpt-5.6-terra", reasoningEffort: "high" }
    });
    release!();
    await settled();
    expect(writes).toHaveLength(2);
  });

  it("drops pending defaults for the previous target on target change", async () => {
    const writes: Array<{ id: string; patch: ComposerSettingsDraft }> = [];
    let release: (() => void) | null = null;
    const rememberDefaults = (id: string, patch: ComposerSettingsDraft) =>
      new Promise<void>((resolve) => {
        writes.push({ id, patch });
        release = resolve;
      });
    const { core } = createHarness(rememberDefaults);
    core.setSettings({ model: "gpt-5.6-sol" });
    core.setSettings({ speed: "fast" }); // pending behind the in-flight write
    core.setContext({ agentTargetId: "local:claude-code", cwd: "/repo" });
    release!();
    await settled();
    expect(writes).toHaveLength(1);
    expect(writes[0]!.id).toBe("local:codex");
  });

  it("keeps snapshot reference stable when nothing changes", () => {
    const { core } = createHarness();
    const first = core.getSnapshot();
    expect(core.getSnapshot()).toBe(first);
    core.setContext({ agentTargetId: "local:codex", cwd: "/repo" });
    expect(core.getSnapshot()).toBe(first);
  });
});
