import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  DesktopAgentSessionReplayPhase,
  DesktopAgentSessionReplayStatus,
  DesktopAgentSessionReplayTimingMode,
  DesktopSendAgentSessionReplayControlInput
} from "../shared/contracts/ipc.ts";

const replayPhases = new Set<DesktopAgentSessionReplayPhase>([
  "replaying",
  "verifying",
  "complete",
  "failed"
]);
const replayTimingModes = new Set<DesktopAgentSessionReplayTimingMode>([
  "realtime",
  "fast-forward"
]);

export async function readAgentSessionReplayStatus(
  statusPath = process.env.TUTTI_AGENT_SESSION_REPLAY_STATUS_PATH
): Promise<DesktopAgentSessionReplayStatus> {
  if (!statusPath?.trim()) {
    return { active: false };
  }
  try {
    const parsed = JSON.parse(await readFile(statusPath, "utf8")) as {
      currentCheckpoint?: unknown;
      errorMessage?: unknown;
      paused?: unknown;
      phase?: unknown;
      targetCheckpoint?: unknown;
      timingMode?: unknown;
      totalCheckpoints?: unknown;
    };
    if (
      typeof parsed.phase !== "string" ||
      !replayPhases.has(parsed.phase as DesktopAgentSessionReplayPhase)
    ) {
      return { active: false };
    }
    const catalog = await readReplayCassetteCatalog(
      join(dirname(statusPath), "replay-catalog.json")
    );
    return {
      active: true,
      ...catalog,
      ...(isNonNegativeInteger(parsed.currentCheckpoint)
        ? { currentCheckpoint: parsed.currentCheckpoint }
        : {}),
      ...(typeof parsed.errorMessage === "string" && parsed.errorMessage.trim()
        ? { errorMessage: parsed.errorMessage }
        : {}),
      ...(typeof parsed.paused === "boolean" ? { paused: parsed.paused } : {}),
      phase: parsed.phase as DesktopAgentSessionReplayPhase,
      ...(parsed.targetCheckpoint === null
        ? { targetCheckpoint: null }
        : isNonNegativeInteger(parsed.targetCheckpoint)
          ? { targetCheckpoint: parsed.targetCheckpoint }
          : {}),
      ...(typeof parsed.timingMode === "string" &&
      replayTimingModes.has(
        parsed.timingMode as DesktopAgentSessionReplayTimingMode
      )
        ? {
            timingMode: parsed.timingMode as DesktopAgentSessionReplayTimingMode
          }
        : {}),
      ...(isNonNegativeInteger(parsed.totalCheckpoints)
        ? { totalCheckpoints: parsed.totalCheckpoints }
        : {})
    };
  } catch {
    return { active: false };
  }
}

export function createAgentSessionReplayControlWriter(
  controlPath = process.env.TUTTI_AGENT_SESSION_REPLAY_CONTROL_PATH
): (input: DesktopSendAgentSessionReplayControlInput) => Promise<void> {
  let pending = Promise.resolve();
  let temporaryFileSequence = 0;
  return (input) => {
    const write = pending.then(async () => {
      if (!controlPath?.trim()) {
        throw new Error("Replay control is unavailable");
      }
      const revision = (await readReplayControlRevision(controlPath)) + 1;
      temporaryFileSequence += 1;
      const temporaryPath = `${controlPath}.${process.pid}.${temporaryFileSequence}.tmp`;
      try {
        await writeFile(
          temporaryPath,
          JSON.stringify({
            schemaVersion: 1,
            revision,
            command: input.command,
            ...("cassetteId" in input ? { cassetteId: input.cassetteId } : {})
          })
        );
        await rename(temporaryPath, controlPath);
      } catch (error) {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
        throw error;
      }
    });
    pending = write.catch(() => undefined);
    return write;
  };
}

async function readReplayCassetteCatalog(
  path: string
): Promise<Pick<DesktopAgentSessionReplayStatus, "cassetteId" | "cassettes">> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as {
      cassetteId?: unknown;
      cassettes?: unknown;
    };
    if (
      typeof parsed.cassetteId !== "string" ||
      !Array.isArray(parsed.cassettes)
    ) {
      return {};
    }
    const cassettes = parsed.cassettes.flatMap((cassette) => {
      const value = cassette as { id?: unknown; name?: unknown };
      return typeof value.id === "string" &&
        typeof value.name === "string" &&
        value.id.trim() &&
        value.name.trim()
        ? [{ id: value.id, name: value.name }]
        : [];
    });
    return { cassetteId: parsed.cassetteId, cassettes };
  } catch {
    return {};
  }
}

async function readReplayControlRevision(controlPath: string): Promise<number> {
  try {
    const parsed = JSON.parse(await readFile(controlPath, "utf8")) as {
      revision?: unknown;
    };
    return Number.isSafeInteger(parsed.revision) &&
      (parsed.revision as number) >= 0
      ? (parsed.revision as number)
      : 0;
  } catch {
    return 0;
  }
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
