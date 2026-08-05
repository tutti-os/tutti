import type {
  EngineExternalCommand,
  EngineIntent
} from "@tutti-os/agent-activity-core";
import type { TuttidClient } from "@tutti-os/client-tuttid-ts";
import { AgentSessionRecordingBinding } from "./agentSessionRecordingBinding.ts";
import {
  AgentSessionActivityEventRecorder,
  createTuttidAgentSessionActivityEventAppender
} from "./agentSessionActivityEventRecorder.ts";

function normalizeReplayWorkspaceId(workspaceId: string): string {
  return workspaceId.trim() || "__default__";
}

export interface AgentSessionEngineActivityObserver {
  observeCommand(command: EngineExternalCommand): void;
  observeIntent(intent: EngineIntent): void;
}

export class AgentSessionReplayActivityBridge {
  private readonly enabled: boolean;
  private readonly tuttidClient: TuttidClient;
  private sessionRecordingBinding: AgentSessionRecordingBinding | null = null;
  private sessionActivityEventRecorders: Map<
    string,
    AgentSessionActivityEventRecorder
  > | null = null;
  private sessionEngineActivityObservers: Map<
    string,
    Set<AgentSessionEngineActivityObserver>
  > | null = null;

  constructor(input: { enabled?: boolean; tuttidClient: TuttidClient }) {
    this.enabled = input.enabled === true;
    this.tuttidClient = input.tuttidClient;
  }

  armNextSessionRecording(workspaceId: string, recordingId: string): void {
    this.assertEnabled();
    (this.sessionRecordingBinding ??= new AgentSessionRecordingBinding()).arm(
      workspaceId,
      recordingId
    );
  }

  clearNextSessionRecording(workspaceId: string, recordingId?: string): void {
    this.sessionRecordingBinding?.clear(workspaceId, recordingId);
  }

  startSessionActivityEventRecording(
    workspaceId: string,
    recordingId: string
  ): void {
    const normalizedWorkspaceId = normalizeReplayWorkspaceId(workspaceId);
    this.assertEnabled();
    const recorders = (this.sessionActivityEventRecorders ??= new Map());
    const existing = recorders.get(normalizedWorkspaceId);
    const recorder =
      existing ??
      new AgentSessionActivityEventRecorder({
        appender: createTuttidAgentSessionActivityEventAppender({
          tuttidClient: this.tuttidClient,
          workspaceId: normalizedWorkspaceId
        })
      });
    recorder.start({
      recordingId,
      scopeId: normalizedWorkspaceId
    });
    if (!existing) {
      recorders.set(normalizedWorkspaceId, recorder);
    }
  }

  async sealSessionActivityEventRecording(
    workspaceId: string,
    recordingId: string
  ): Promise<void> {
    const normalizedWorkspaceId = normalizeReplayWorkspaceId(workspaceId);
    const recorders = this.sessionActivityEventRecorders;
    const recorder = recorders?.get(normalizedWorkspaceId);
    if (!recorder) return;
    await recorder.seal(recordingId);
    if (recorders?.get(normalizedWorkspaceId) === recorder) {
      recorders.delete(normalizedWorkspaceId);
      if (recorders.size === 0) this.sessionActivityEventRecorders = null;
    }
  }

  discardSessionActivityEventRecording(
    workspaceId: string,
    recordingId: string
  ): void {
    const normalizedWorkspaceId = normalizeReplayWorkspaceId(workspaceId);
    const recorders = this.sessionActivityEventRecorders;
    if (!recorders) return;
    const recorder = recorders.get(normalizedWorkspaceId);
    if (!recorder) return;
    recorder.discard(recordingId);
    recorders.delete(normalizedWorkspaceId);
    if (recorders.size === 0) this.sessionActivityEventRecorders = null;
  }

  addSessionEngineActivityObserver(
    workspaceId: string,
    observer: AgentSessionEngineActivityObserver
  ): () => void {
    const normalizedWorkspaceId = normalizeReplayWorkspaceId(workspaceId);
    this.assertEnabled();
    const observerMap = (this.sessionEngineActivityObservers ??= new Map());
    let observers = observerMap.get(normalizedWorkspaceId);
    if (!observers) {
      observers = new Set();
      observerMap.set(normalizedWorkspaceId, observers);
    }
    observers.add(observer);
    return () => {
      observers?.delete(observer);
      if (observers?.size === 0) {
        observerMap.delete(normalizedWorkspaceId);
        if (observerMap.size === 0) this.sessionEngineActivityObservers = null;
      }
    };
  }

  createSessionEngineActivityObserver(
    workspaceId: string
  ): AgentSessionEngineActivityObserver {
    const normalizedWorkspaceId = normalizeReplayWorkspaceId(workspaceId);
    this.assertEnabled();
    return {
      observeCommand: (command) => {
        this.sessionActivityEventRecorders
          ?.get(normalizedWorkspaceId)
          ?.observeCommand(command);
        this.notifySessionEngineActivityObservers(
          normalizedWorkspaceId,
          "observeCommand",
          command
        );
      },
      observeIntent: (intent) => {
        this.sessionActivityEventRecorders
          ?.get(normalizedWorkspaceId)
          ?.observeIntent(intent);
        this.notifySessionEngineActivityObservers(
          normalizedWorkspaceId,
          "observeIntent",
          intent
        );
      }
    };
  }

  takePendingSessionRecording(workspaceId: string): string | null {
    return this.sessionRecordingBinding?.take(workspaceId) ?? null;
  }

  restorePendingSessionRecording(
    workspaceId: string,
    recordingId: string
  ): void {
    this.sessionRecordingBinding?.restore(workspaceId, recordingId);
  }

  private assertEnabled(): void {
    if (!this.enabled) {
      throw new Error("agent_session_replay_not_composed");
    }
  }

  private notifySessionEngineActivityObservers(
    workspaceId: string,
    method: "observeCommand",
    value: EngineExternalCommand
  ): void;
  private notifySessionEngineActivityObservers(
    workspaceId: string,
    method: "observeIntent",
    value: EngineIntent
  ): void;
  private notifySessionEngineActivityObservers(
    workspaceId: string,
    method: "observeCommand" | "observeIntent",
    value: EngineExternalCommand | EngineIntent
  ): void {
    const observers = this.sessionEngineActivityObservers?.get(workspaceId);
    if (!observers) return;
    for (const observer of observers) {
      try {
        if (method === "observeCommand") {
          observer.observeCommand(value as EngineExternalCommand);
        } else {
          observer.observeIntent(value as EngineIntent);
        }
      } catch {
        // Replay instrumentation cannot block the product command path.
      }
    }
  }
}
