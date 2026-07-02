import assert from "node:assert/strict";
import test from "node:test";
import type {
  AgentProbeProvider,
  AgentProbeSnapshot
} from "@tutti-os/agent-gui";
import { mergeDesktopAgentProbeSnapshots } from "./desktopAgentProbeSnapshot.ts";

test("merges incoming provider probes without dropping existing providers", () => {
  const merged = mergeDesktopAgentProbeSnapshots(
    createSnapshot({
      capturedAtUnixMs: 100,
      providers: [createProvider("claude-code", 0)]
    }),
    createSnapshot({
      capturedAtUnixMs: 120,
      providers: [createProvider("codex", 4)]
    })
  );

  assert.equal(merged.capturedAtUnixMs, 120);
  assert.deepEqual(
    merged.providers.map((provider) => provider.provider),
    ["claude-code", "codex"]
  );
  assert.equal(merged.providers[0]?.usage?.quotas?.length, 0);
  assert.equal(merged.providers[1]?.usage?.quotas?.length, 4);
});

test("replaces only matching provider probe", () => {
  const merged = mergeDesktopAgentProbeSnapshots(
    createSnapshot({
      capturedAtUnixMs: 150,
      providers: [createProvider("claude-code", 0), createProvider("codex", 4)]
    }),
    createSnapshot({
      capturedAtUnixMs: 160,
      providers: [
        {
          ...createProvider("codex", 0),
          lastError: {
            code: "execution_failed",
            message: "probe failed"
          },
          usage: undefined
        }
      ]
    })
  );

  assert.equal(merged.providers.length, 2);
  assert.equal(merged.providers[0]?.provider, "claude-code");
  assert.equal(merged.providers[0]?.usage?.quotas?.length, 0);
  assert.equal(merged.providers[1]?.provider, "codex");
  assert.equal(merged.providers[1]?.usage, undefined);
  assert.equal(merged.providers[1]?.lastError?.code, "execution_failed");
});

test("uses incoming snapshot when workspace or room differs", () => {
  const incoming = createSnapshot({
    providers: [createProvider("codex", 1)],
    roomId: "room-b",
    workspaceId: "workspace-b"
  });

  const merged = mergeDesktopAgentProbeSnapshots(
    createSnapshot({
      providers: [createProvider("claude-code", 0)],
      roomId: "room-a",
      workspaceId: "workspace-a"
    }),
    incoming
  );

  assert.equal(merged, incoming);
});

function createSnapshot(input: {
  capturedAtUnixMs?: number;
  providers: AgentProbeProvider[];
  roomId?: string;
  workspaceId?: string;
}): AgentProbeSnapshot {
  return {
    capturedAtUnixMs: input.capturedAtUnixMs ?? 100,
    providers: input.providers,
    roomId: input.roomId,
    workspaceId: input.workspaceId ?? "workspace-1"
  };
}

function createProvider(
  provider: string,
  quotaCount: number
): AgentProbeProvider {
  return {
    availability: {
      detailsVisible: false,
      status: "available"
    },
    provider,
    usage: {
      capturedAtUnixMs: 100,
      quotas: Array.from({ length: quotaCount }, () => ({
        quotaType: "session"
      }))
    }
  };
}
