import { useEffect, useState } from "react";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  Button,
  PauseIcon,
  PlayIcon,
  RefreshIcon,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from "@tutti-os/ui-system";
import type { DesktopRuntimeApi } from "@preload/types";
import type {
  DesktopAgentSessionReplayPlayback,
  DesktopAgentSessionReplayPlaybackSpeed,
  DesktopAgentSessionReplayStatus,
  DesktopSendAgentSessionReplayControlInput
} from "@shared/contracts/ipc";
import { useTranslation } from "@renderer/i18n";
import { Toast } from "@renderer/lib/toast";
import {
  areAgentSessionReplayPlaybackSnapshotsEqual,
  shouldPollAgentSessionReplayPlayback
} from "./agentSessionReplayPlaybackPolling.ts";
import { resolveAgentSessionReplayControlAvailability } from "./agentSessionReplayPlaybackControls.ts";

const playbackSpeeds = [0.25, 0.5, 1, 2, 4] as const;
const playbackPollIntervalMs = 250;

interface ReplayPlaybackSnapshot {
  playback: DesktopAgentSessionReplayPlayback;
  status: DesktopAgentSessionReplayStatus;
}

export function AgentSessionReplayPlaybackControls({
  runtimeApi
}: {
  runtimeApi: Pick<
    DesktopRuntimeApi,
    | "getAgentSessionReplayPlayback"
    | "getAgentSessionReplayStatus"
    | "sendAgentSessionReplayControl"
    | "setAgentSessionReplayPlayback"
  >;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<ReplayPlaybackSnapshot | null>(null);
  const [updating, setUpdating] = useState(false);

  useEffect(() => {
    let disposed = false;
    let timer: number | undefined;
    const poll = async (): Promise<void> => {
      try {
        const [playback, status] = await Promise.all([
          runtimeApi.getAgentSessionReplayPlayback(),
          runtimeApi.getAgentSessionReplayStatus()
        ]);
        if (disposed) return;
        const next = { playback, status };
        setSnapshot((current) =>
          playback.active &&
          !areAgentSessionReplayPlaybackSnapshotsEqual(current, next)
            ? next
            : playback.active
              ? current
              : null
        );
        if (shouldPollAgentSessionReplayPlayback(playback, status)) {
          timer = window.setTimeout(poll, playbackPollIntervalMs);
        }
      } catch {
        if (!disposed) setSnapshot(null);
      }
    };
    void poll();
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [runtimeApi]);

  if (!snapshot) {
    return null;
  }
  const { playback, status } = snapshot;
  const currentCheckpoint = status.currentCheckpoint ?? 0;
  const lastCheckpoint = Math.max(0, (status.totalCheckpoints ?? 1) - 1);
  const { canNext, canPause, canPrevious, canReplace, canSetSpeed } =
    resolveAgentSessionReplayControlAvailability({
      currentCheckpoint,
      lastCheckpoint,
      phase: status.phase,
      updating
    });

  const updateSpeed = (value: string): void => {
    const speed = playbackSpeeds.find(
      (candidate) => String(candidate) === value
    );
    if (!speed || speed === playback.speed || updating) {
      return;
    }
    setUpdating(true);
    void runtimeApi
      .setAgentSessionReplayPlayback({ command: "set-speed", speed })
      .then((next) =>
        setSnapshot((current) =>
          current ? { ...current, playback: next } : current
        )
      )
      .catch(() =>
        Toast.Error(t("workspace.agentGui.sessionReplay.replay.speedFailed"))
      )
      .finally(() => setUpdating(false));
  };

  const sendControl = (
    command: Exclude<
      DesktopSendAgentSessionReplayControlInput["command"],
      "switch-cassette"
    >
  ): void => {
    if (updating) return;
    setUpdating(true);
    void runtimeApi
      .sendAgentSessionReplayControl({ command })
      .catch(() =>
        Toast.Error(t("workspace.agentGui.sessionReplay.replay.controlFailed"))
      )
      .finally(() => setUpdating(false));
  };
  const switchCassette = (cassetteId: string): void => {
    if (updating || cassetteId === status.cassetteId) return;
    setUpdating(true);
    void runtimeApi
      .sendAgentSessionReplayControl({
        cassetteId,
        command: "switch-cassette"
      })
      .catch(() =>
        Toast.Error(t("workspace.agentGui.sessionReplay.replay.controlFailed"))
      )
      .finally(() => setUpdating(false));
  };

  return (
    <div
      aria-label={t("workspace.agentGui.sessionReplay.replay.toolbar")}
      className="nodrag flex items-center gap-0.5 [-webkit-app-region:no-drag]"
      data-testid="agent-session-replay-playback-controls"
      role="toolbar"
    >
      {status.cassetteId && status.cassettes?.length ? (
        <Select value={status.cassetteId} onValueChange={switchCassette}>
          <SelectTrigger
            aria-label={t("workspace.agentGui.sessionReplay.replay.cassette")}
            className="h-7 min-w-28 max-w-44"
            disabled={!canReplace}
            size="sm"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent style={{ zIndex: "var(--z-panel-popover)" }}>
            {status.cassettes.map((cassette) => (
              <SelectItem key={cassette.id} value={cassette.id}>
                {cassette.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
      <ReplayControlButton
        disabled={!canReplace}
        label={t("workspace.agentGui.sessionReplay.replay.restart")}
        onClick={() => sendControl("restart")}
      >
        <RefreshIcon aria-hidden="true" />
      </ReplayControlButton>
      <ReplayControlButton
        disabled={!canPrevious}
        label={t("workspace.agentGui.sessionReplay.replay.previous")}
        onClick={() => sendControl("previous-checkpoint")}
      >
        <ArrowLeftIcon aria-hidden="true" />
      </ReplayControlButton>
      <ReplayControlButton
        disabled={!canPause}
        label={t(
          playback.paused
            ? "workspace.agentGui.sessionReplay.replay.play"
            : "workspace.agentGui.sessionReplay.replay.pause"
        )}
        onClick={() => sendControl(playback.paused ? "resume" : "pause")}
      >
        {playback.paused ? (
          <PlayIcon aria-hidden="true" />
        ) : (
          <PauseIcon aria-hidden="true" />
        )}
      </ReplayControlButton>
      <ReplayControlButton
        disabled={!canNext}
        label={t("workspace.agentGui.sessionReplay.replay.next")}
        onClick={() => sendControl("next-checkpoint")}
      >
        <ArrowRightIcon aria-hidden="true" />
      </ReplayControlButton>
      <span
        aria-label={t("workspace.agentGui.sessionReplay.replay.checkpoint", {
          current: currentCheckpoint,
          total: lastCheckpoint
        })}
        className="min-w-10 px-1 text-center text-xs tabular-nums text-[var(--text-secondary)]"
      >
        {currentCheckpoint}/{lastCheckpoint}
      </span>
      <Select value={String(playback.speed)} onValueChange={updateSpeed}>
        <SelectTrigger
          aria-label={t("workspace.agentGui.sessionReplay.replay.speed")}
          className="h-7 min-w-16"
          disabled={!canSetSpeed}
          size="sm"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent style={{ zIndex: "var(--z-panel-popover)" }}>
          {playbackSpeeds.map((speed) => (
            <SelectItem key={speed} value={String(speed)}>
              {formatPlaybackSpeed(speed)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function ReplayControlButton({
  children,
  disabled,
  label,
  onClick
}: {
  children: React.ReactNode;
  disabled: boolean;
  label: string;
  onClick(): void;
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}

function formatPlaybackSpeed(
  speed: DesktopAgentSessionReplayPlaybackSpeed
): string {
  return `${speed}×`;
}
