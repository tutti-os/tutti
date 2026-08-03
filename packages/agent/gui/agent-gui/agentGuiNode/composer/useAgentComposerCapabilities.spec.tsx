import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentHostComposerCapabilitiesApi,
  AgentHostComposerCapabilitiesSnapshot,
  AgentHostRuntimeApi
} from "../../../host/agentHostApi";
import { useAgentComposerCapabilities } from "./useAgentComposerCapabilities";

let hostApi: AgentHostRuntimeApi | null = null;

vi.mock("../../../agentActivityHost", () => ({
  useOptionalAgentHostApi: () => hostApi
}));

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

describe("useAgentComposerCapabilities", () => {
  beforeEach(() => {
    hostApi = null;
  });

  it("selects the current controller snapshot only after the composer lifecycle syncs it", async () => {
    const list = vi
      .fn<AgentHostComposerCapabilitiesApi["list"]>()
      .mockResolvedValue(READY);
    hostApi = createHostApi(list);
    const rendered = renderHook(() =>
      useAgentComposerCapabilities({
        agentTargetId: "local:codex",
        authoritativeSkills: [],
        cwd: "/workspace",
        provider: "codex"
      })
    );

    expect(rendered.result.current.snapshot).toEqual(PARTIAL);
    act(() => rendered.result.current.sync(false));
    await waitFor(() => {
      expect(rendered.result.current.snapshot).toEqual(READY);
    });
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("never sends connector entries into Plugin to Skill proof", async () => {
    const list = vi
      .fn<AgentHostComposerCapabilitiesApi["list"]>()
      .mockResolvedValue(READY);
    hostApi = createHostApi(list);
    const rendered = renderHook(() =>
      useAgentComposerCapabilities({
        agentTargetId: "local:codex",
        authoritativeSkills: [
          {
            kind: "connector",
            name: "github",
            path: "app://github",
            sourceKind: "connector",
            trigger: "$github"
          },
          {
            kind: "skill",
            name: "sites:sites-building",
            path: "/plugins/sites/skills/sites-building/SKILL.md",
            sourceKind: "bundled",
            trigger: "$sites:sites-building"
          }
        ],
        cwd: "/workspace",
        provider: "codex"
      })
    );

    act(() => rendered.result.current.sync(false));
    await waitFor(() => expect(list).toHaveBeenCalled());
    expect(list.mock.calls[0]?.[0].authoritativeSkills).toEqual([
      expect.objectContaining({ kind: "skill", name: "sites:sites-building" })
    ]);
  });

  it("does not query an unsupported host target", () => {
    const list = vi.fn<AgentHostComposerCapabilitiesApi["list"]>();
    const prime = vi.fn<AgentHostComposerCapabilitiesApi["prime"]>();
    hostApi = createHostApi(list, prime, false);
    const rendered = renderHook(() =>
      useAgentComposerCapabilities({
        agentTargetId: "extension:cursor",
        authoritativeSkills: [],
        cwd: "/workspace",
        provider: "cursor"
      })
    );

    act(() => rendered.result.current.sync(true));
    expect(rendered.result.current.snapshot).toEqual(PARTIAL);
    expect(list).not.toHaveBeenCalled();
    expect(prime).not.toHaveBeenCalled();
  });
});

function createHostApi(
  list: AgentHostComposerCapabilitiesApi["list"],
  prime: AgentHostComposerCapabilitiesApi["prime"] = vi.fn(async () => {}),
  supported = true
): AgentHostRuntimeApi {
  return {
    composerCapabilities: {
      isSupported: () => supported,
      list,
      prime
    }
  } as unknown as AgentHostRuntimeApi;
}
