import type {
  AgentSessionRecording,
  TuttidClient
} from "@tutti-os/client-tuttid-ts";

export interface AgentSessionReplaySnapshot {
  activeRecording: AgentSessionRecording | null;
  error: unknown;
  loading: boolean;
  recordings: readonly AgentSessionRecording[];
}

export interface AgentSessionReplayServiceDependencies {
  armNextSessionRecording(recordingId: string): void;
  clearNextSessionRecording(recordingId?: string): void;
  discardActivityEventRecording(recordingId: string): void;
  sealActivityEventRecording(recordingId: string): Promise<void>;
  startActivityEventRecording(recordingId: string): void;
  tuttidClient: Pick<
    TuttidClient,
    | "cancelAgentSessionRecording"
    | "completeAgentSessionRecording"
    | "completeAgentSessionReplayRun"
    | "failAgentSessionReplayRun"
    | "listAgentSessionRecordings"
    | "markAgentSessionReplayRunRunning"
    | "prepareAgentSessionReplayRun"
    | "renameAgentSessionRecording"
    | "startAgentSessionRecording"
  >;
  workspaceId: string;
}

const activeStatuses = new Set<AgentSessionRecording["status"]>([
  "preparing",
  "ready",
  "recording",
  "finalizing"
]);

export class AgentSessionReplayService {
  private readonly dependencies: AgentSessionReplayServiceDependencies;
  private readonly listeners = new Set<() => void>();
  private snapshot: AgentSessionReplaySnapshot = {
    activeRecording: null,
    error: null,
    loading: false,
    recordings: []
  };
  private refreshPromise: Promise<void> | null = null;

  constructor(dependencies: AgentSessionReplayServiceDependencies) {
    this.dependencies = dependencies;
  }

  getSnapshot = (): AgentSessionReplaySnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async refresh(options: { background?: boolean } = {}): Promise<void> {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }
    if (!options.background) {
      this.update({ loading: true });
    }
    this.refreshPromise = this.loadRecordings();
    try {
      await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  async startRecording(input: {
    agentSessionId?: string | null;
    agentTargetId: string;
  }): Promise<void> {
    this.update({ error: null, loading: true });
    try {
      const recording =
        await this.dependencies.tuttidClient.startAgentSessionRecording(
          this.dependencies.workspaceId,
          {
            agentTargetId: input.agentTargetId,
            agentSessionId: input.agentSessionId ?? undefined
          }
        );
      this.dependencies.startActivityEventRecording(recording.id);
      if (!input.agentSessionId) {
        this.dependencies.armNextSessionRecording(recording.id);
      }
      this.replaceRecording(recording);
    } catch (error) {
      this.update({ error });
      throw error;
    } finally {
      this.update({ loading: false });
    }
  }

  async completeRecording(recordingId: string): Promise<void> {
    this.update({ error: null, loading: true });
    try {
      await this.dependencies.sealActivityEventRecording(recordingId);
      const recording =
        await this.dependencies.tuttidClient.completeAgentSessionRecording(
          this.dependencies.workspaceId,
          recordingId
        );
      this.dependencies.clearNextSessionRecording(recordingId);
      this.replaceRecording(recording);
    } catch (error) {
      this.update({ error });
      throw error;
    } finally {
      this.update({ loading: false });
    }
  }

  async cancelRecording(recordingId: string): Promise<void> {
    this.update({ error: null, loading: true });
    try {
      await this.dependencies.tuttidClient.cancelAgentSessionRecording(
        this.dependencies.workspaceId,
        recordingId
      );
      this.dependencies.discardActivityEventRecording(recordingId);
      this.dependencies.clearNextSessionRecording(recordingId);
      this.removeRecording(recordingId);
    } catch (error) {
      this.update({ error });
      throw error;
    } finally {
      this.update({ loading: false });
    }
  }

  async renameRecording(recordingId: string, name: string): Promise<void> {
    this.update({ error: null, loading: true });
    try {
      const recording =
        await this.dependencies.tuttidClient.renameAgentSessionRecording(
          this.dependencies.workspaceId,
          recordingId,
          { name: name.trim() }
        );
      this.replaceRecording(recording);
    } catch (error) {
      this.update({ error });
      throw error;
    } finally {
      this.update({ loading: false });
    }
  }

  prepareReplayRun(cassetteId: string) {
    return this.dependencies.tuttidClient.prepareAgentSessionReplayRun(
      this.dependencies.workspaceId,
      cassetteId
    );
  }

  markReplayRunRunning(runId: string) {
    return this.dependencies.tuttidClient.markAgentSessionReplayRunRunning(
      this.dependencies.workspaceId,
      runId
    );
  }

  completeReplayRun(runId: string) {
    return this.dependencies.tuttidClient.completeAgentSessionReplayRun(
      this.dependencies.workspaceId,
      runId
    );
  }

  failReplayRun(runId: string, error: unknown) {
    return this.dependencies.tuttidClient.failAgentSessionReplayRun(
      this.dependencies.workspaceId,
      runId,
      {
        errorCode: "replay_runtime_failed",
        errorMessage:
          error instanceof Error && error.message.trim()
            ? error.message
            : String(error)
      }
    );
  }

  private async loadRecordings(): Promise<void> {
    try {
      const recordings =
        await this.dependencies.tuttidClient.listAgentSessionRecordings(
          this.dependencies.workspaceId
        );
      const nextRecordings = recordingsEqual(
        this.snapshot.recordings,
        recordings
      )
        ? this.snapshot.recordings
        : recordings;
      const nextSnapshot: AgentSessionReplaySnapshot = {
        activeRecording:
          nextRecordings.find((recording) =>
            activeStatuses.has(recording.status)
          ) ?? null,
        error: null,
        loading: false,
        recordings: nextRecordings
      };
      if (
        nextSnapshot.activeRecording === this.snapshot.activeRecording &&
        nextSnapshot.error === this.snapshot.error &&
        nextSnapshot.loading === this.snapshot.loading &&
        nextSnapshot.recordings === this.snapshot.recordings
      ) {
        return;
      }
      this.snapshot = nextSnapshot;
      this.emit();
    } catch (error) {
      this.update({ error, loading: false });
    }
  }

  private replaceRecording(recording: AgentSessionRecording): void {
    const recordings = [
      recording,
      ...this.snapshot.recordings.filter((item) => item.id !== recording.id)
    ];
    this.snapshot = {
      ...this.snapshot,
      activeRecording: activeStatuses.has(recording.status) ? recording : null,
      error: null,
      recordings
    };
    this.emit();
  }

  private removeRecording(recordingId: string): void {
    this.snapshot = {
      ...this.snapshot,
      activeRecording:
        this.snapshot.activeRecording?.id === recordingId
          ? null
          : this.snapshot.activeRecording,
      error: null,
      recordings: this.snapshot.recordings.filter(
        (recording) => recording.id !== recordingId
      )
    };
    this.emit();
  }

  private update(patch: Partial<AgentSessionReplaySnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

function recordingsEqual(
  left: readonly AgentSessionRecording[],
  right: readonly AgentSessionRecording[]
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (recording, index) =>
        recording.id === right[index]?.id &&
        recording.updatedAtUnixMs === right[index]?.updatedAtUnixMs
    )
  );
}
