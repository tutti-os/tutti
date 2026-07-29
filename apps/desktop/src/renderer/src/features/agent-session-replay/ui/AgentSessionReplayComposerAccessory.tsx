import { useEffect, useState, useSyncExternalStore } from "react";
import type { AgentGUIProps } from "@tutti-os/agent-gui";
import {
  Badge,
  Button,
  CheckIcon,
  CloseIcon,
  EditIcon,
  Input,
  PlayIcon,
  Popover,
  PopoverContent,
  PopoverTrigger,
  ScrollArea,
  ViewListLinedIcon
} from "@tutti-os/ui-system";
import { useTranslation } from "@renderer/i18n";
import { Toast } from "@renderer/lib/toast";
import type { AgentSessionReplayLauncher } from "../services/agentSessionReplayLauncher.ts";
import type { AgentSessionReplayService } from "../services/agentSessionReplayService.ts";
import { replayActionErrorMessage } from "./replayActionErrorMessage.ts";

type ComposerContext = Parameters<
  NonNullable<AgentGUIProps["renderSlots"]["composerFooterAccessory"]>
>[0];

export function AgentSessionReplayComposerAccessory({
  composer,
  launcher,
  service
}: {
  composer: ComposerContext;
  launcher?: AgentSessionReplayLauncher;
  service: AgentSessionReplayService;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(
    service.subscribe,
    service.getSnapshot,
    service.getSnapshot
  );
  useEffect(() => {
    void service.refresh();
  }, [service]);
  useEffect(() => {
    if (!snapshot.activeRecording) {
      return;
    }
    const timer = window.setInterval(
      () => void service.refresh({ background: true }),
      1_000
    );
    return () => window.clearInterval(timer);
  }, [service, snapshot.activeRecording?.id]);

  const agentTargetId =
    composer.selectedAgentTarget?.agentTargetId ??
    composer.selectedAgentTarget?.targetId ??
    "";
  if (
    agentTargetId !== "local:codex" &&
    !snapshot.activeRecording &&
    snapshot.recordings.length === 0
  ) {
    return null;
  }

  return (
    <div
      className="nodrag inline-flex min-w-0 shrink-0 items-center gap-1"
      data-testid="agent-session-replay-tools"
    >
      <RecordingToolbar
        agentSessionId={composer.agentSessionId ?? null}
        agentTargetId={agentTargetId}
        disabled={snapshot.loading}
        service={service}
        status={snapshot.activeRecording?.status ?? null}
        recordingId={snapshot.activeRecording?.id ?? null}
      />
      <RecordingList
        disabled={snapshot.loading}
        launcher={launcher}
        recordings={snapshot.recordings}
        service={service}
      />
      {snapshot.error ? (
        <span className="sr-only" role="alert">
          {t("workspace.agentGui.sessionReplay.failed")}
        </span>
      ) : null}
    </div>
  );
}

function RecordingToolbar({
  agentSessionId,
  agentTargetId,
  disabled,
  recordingId,
  service,
  status
}: {
  agentSessionId: string | null;
  agentTargetId: string;
  disabled: boolean;
  recordingId: string | null;
  service: AgentSessionReplayService;
  status: string | null;
}): React.JSX.Element {
  const { t } = useTranslation();
  const describeError = (error: unknown): string =>
    replayActionErrorMessage(error, (table) =>
      t("workspace.agentGui.sessionReplay.replay.stateMismatch", { table })
    );
  if (!recordingId) {
    return (
      <Button
        aria-label={t("workspace.agentGui.sessionReplay.record.start")}
        disabled={disabled || !agentTargetId}
        size="icon-sm"
        variant="ghost"
        onClick={() =>
          void service
            .startRecording({ agentSessionId, agentTargetId })
            .catch((error) =>
              Toast.Error(
                t("workspace.agentGui.sessionReplay.failed"),
                describeError(error)
              )
            )
        }
      >
        <span aria-hidden="true" className="size-3 rounded-full bg-current" />
      </Button>
    );
  }
  return (
    <>
      <Button
        aria-label={t("workspace.agentGui.sessionReplay.record.stop")}
        disabled={disabled || status !== "recording"}
        size="icon-sm"
        variant="ghost"
        onClick={() =>
          void service
            .completeRecording(recordingId)
            .catch((error) =>
              Toast.Error(
                t("workspace.agentGui.sessionReplay.failed"),
                describeError(error)
              )
            )
        }
      >
        <span aria-hidden="true" className="size-3 rounded-[2px] bg-current" />
      </Button>
      <Button
        aria-label={t("workspace.agentGui.sessionReplay.record.cancel")}
        disabled={disabled}
        size="icon-sm"
        variant="ghost"
        onClick={() =>
          void service
            .cancelRecording(recordingId)
            .catch((error) =>
              Toast.Error(
                t("workspace.agentGui.sessionReplay.failed"),
                describeError(error)
              )
            )
        }
      >
        <CloseIcon aria-hidden="true" className="size-3" />
      </Button>
    </>
  );
}

function RecordingList({
  disabled,
  launcher,
  recordings,
  service
}: {
  disabled: boolean;
  launcher?: AgentSessionReplayLauncher;
  recordings: readonly {
    cassetteId?: string | null;
    id: string;
    name: string;
    status: string;
  }[];
  service: AgentSessionReplayService;
}): React.JSX.Element {
  const { t } = useTranslation();
  const describeError = (error: unknown): string =>
    replayActionErrorMessage(error, (table) =>
      t("workspace.agentGui.sessionReplay.replay.stateMismatch", { table })
    );
  const [open, setOpen] = useState(false);
  const [launchingCassetteId, setLaunchingCassetteId] = useState<string | null>(
    null
  );
  const [editingRecordingId, setEditingRecordingId] = useState<string | null>(
    null
  );
  const [draftName, setDraftName] = useState("");
  const [renamingRecordingId, setRenamingRecordingId] = useState<string | null>(
    null
  );

  const launchReplay = (cassetteId: string): void => {
    if (!launcher || launchingCassetteId) return;
    setLaunchingCassetteId(cassetteId);
    setOpen(false);
    const toast = Toast.Loading(
      t("workspace.agentGui.sessionReplay.replay.launching")
    );
    void launcher
      .launch(cassetteId)
      .then(({ completion }) => {
        toast.resolve(t("workspace.agentGui.sessionReplay.replay.opened"));
        setLaunchingCassetteId(null);
        void completion.catch(() => undefined);
      })
      .catch((error) => {
        toast.reject(
          t("workspace.agentGui.sessionReplay.failed"),
          describeError(error)
        );
        setLaunchingCassetteId(null);
      });
  };
  const renameRecording = (recordingId: string): void => {
    const name = draftName.trim();
    if (!name || renamingRecordingId) return;
    setRenamingRecordingId(recordingId);
    void service
      .renameRecording(recordingId, name)
      .then(() => {
        setEditingRecordingId(null);
        setDraftName("");
      })
      .catch((error) =>
        Toast.Error(
          t("workspace.agentGui.sessionReplay.record.renameFailed"),
          describeError(error)
        )
      )
      .finally(() => setRenamingRecordingId(null));
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          aria-label={t("workspace.agentGui.sessionReplay.list")}
          size="icon-sm"
          variant="ghost"
        >
          <ViewListLinedIcon aria-hidden="true" className="size-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="nodrag w-72 p-2 [-webkit-app-region:no-drag]"
        side="top"
      >
        <p className="px-2 pb-2 text-xs font-medium">
          {t("workspace.agentGui.sessionReplay.list")}
        </p>
        <ScrollArea className="max-h-64">
          {recordings.length === 0 ? (
            <p className="px-2 py-3 text-xs text-[var(--text-secondary)]">
              {t("workspace.agentGui.sessionReplay.empty")}
            </p>
          ) : (
            <div className="flex flex-col gap-1">
              {recordings.map((recording) => (
                <div
                  key={recording.id}
                  className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5"
                >
                  {editingRecordingId === recording.id ? (
                    <>
                      <Input
                        aria-label={t(
                          "workspace.agentGui.sessionReplay.record.rename"
                        )}
                        autoFocus
                        className="h-7 min-w-0 flex-1 text-xs"
                        maxLength={120}
                        value={draftName}
                        onChange={(event) => setDraftName(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            renameRecording(recording.id);
                          } else if (event.key === "Escape") {
                            setEditingRecordingId(null);
                          }
                        }}
                      />
                      <Button
                        aria-label={t(
                          "workspace.agentGui.sessionReplay.record.renameSave"
                        )}
                        disabled={
                          !draftName.trim() ||
                          renamingRecordingId === recording.id
                        }
                        size="icon-sm"
                        variant="ghost"
                        onClick={() => renameRecording(recording.id)}
                      >
                        <CheckIcon aria-hidden="true" className="size-3" />
                      </Button>
                      <Button
                        aria-label={t(
                          "workspace.agentGui.sessionReplay.record.renameCancel"
                        )}
                        disabled={renamingRecordingId === recording.id}
                        size="icon-sm"
                        variant="ghost"
                        onClick={() => setEditingRecordingId(null)}
                      >
                        <CloseIcon aria-hidden="true" className="size-3" />
                      </Button>
                    </>
                  ) : (
                    <>
                      <span className="min-w-0 flex-1 truncate text-xs">
                        {recording.name}
                      </span>
                      {recording.status === "complete" &&
                      recording.cassetteId ? (
                        <Button
                          aria-label={t(
                            "workspace.agentGui.sessionReplay.record.rename"
                          )}
                          disabled={disabled}
                          size="icon-sm"
                          variant="ghost"
                          onClick={() => {
                            setEditingRecordingId(recording.id);
                            setDraftName(recording.name);
                          }}
                        >
                          <EditIcon aria-hidden="true" className="size-3" />
                        </Button>
                      ) : null}
                    </>
                  )}
                  {recording.status === "complete" ? null : (
                    <Badge variant="outline">{recording.status}</Badge>
                  )}
                  {recording.status === "complete" && recording.cassetteId ? (
                    <Button
                      aria-label={t(
                        "workspace.agentGui.sessionReplay.replay.play"
                      )}
                      disabled={
                        disabled || !launcher || launchingCassetteId !== null
                      }
                      size="icon-sm"
                      variant="ghost"
                      onClick={() => launchReplay(recording.cassetteId!)}
                    >
                      <PlayIcon aria-hidden="true" className="size-3" />
                    </Button>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}
