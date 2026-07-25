import {
  AGENT_SESSION_ENGINE_LOCAL_ORIGIN,
  agentActivitySessionMessageWindowFromDescendingPage,
  createAgentActivitySnapshotProjector,
  createAgentSessionEngine,
  selectRootAgentActivitySessions,
  type AgentActivityInteraction,
  type AgentActivitySession,
  type AgentActivitySnapshot,
  type AgentSessionEngine,
  type EngineExternalCommand,
  type PromptQueueSendCommand,
  type SessionActivateCommand
} from "@tutti-os/agent-activity-core";
import {
  agentActivityMessageFromTuttidMessage,
  agentActivitySessionFromTuttidSession,
  agentActivityTurnFromTuttidTurn
} from "@tutti-os/agent-activity-tuttid-adapter";
import type {
  AgentTarget,
  TuttidClient,
  WorkspaceSummary
} from "@tutti-os/client-tuttid-ts";
import type { AgentDirectoryService } from "./agentDirectoryService";
import type { ComposerDraftService } from "./composerDraftService";
import { ObservableService } from "./observableService";
import {
  resolvePendingSubmission,
  type PendingSubmission
} from "./pendingSubmission";
import type { ClockPort } from "./servicePorts";
import {
  createMobileActivityCommandId,
  toTuttidPromptContent
} from "./workspaceActivityCommandSupport";
import type { WorkspaceNavigationService } from "./workspaceNavigationService";

const SESSION_POLL_MS = 2_000;
const MESSAGE_POLL_MS = 1_000;
const COMMAND_TIMEOUT_MS = 30_000;
const PENDING_EXPIRY_MS = 60_000;
const MESSAGE_PAGE_SIZE = 100;

export interface WorkspaceActivitySnapshot {
  activity: AgentActivitySnapshot;
  ambiguousSubmission: boolean;
  creating: boolean;
  draft: string;
  errorCode: "request_failed" | null;
  loading: boolean;
  selectedAgentSessionId: string | null;
  selectedAgentTargetId: string | null;
  selectedSession: AgentActivitySession | null;
  sending: boolean;
  targets: readonly AgentTarget[];
}

export class WorkspaceActivityService extends ObservableService<WorkspaceActivitySnapshot> {
  readonly _serviceBrand: undefined;
  private readonly engine: AgentSessionEngine;
  private readonly projectActivity: (
    state: ReturnType<AgentSessionEngine["getSnapshot"]>
  ) => AgentActivitySnapshot;
  private disposed = false;
  private paused = false;
  private initializePromise: Promise<void> | null = null;
  private sessionsInFlight: Promise<void> | null = null;
  private messagesInFlight: Promise<void> | null = null;
  private sessionPollTask: { cancel(): void } | null = null;
  private messagePollTask: { cancel(): void } | null = null;
  private errorCode: "request_failed" | null = null;
  private loading = true;
  private snapshotCache: WorkspaceActivitySnapshot | null = null;
  private readonly disposables: Array<() => void> = [];
  private readonly pendingSubmissionsByDraftKey = new Map<
    string,
    PendingSubmission
  >();
  private readonly ambiguousDraftKeys = new Set<string>();

  constructor(
    readonly workspace: WorkspaceSummary,
    private readonly client: TuttidClient,
    private readonly directory: AgentDirectoryService,
    private readonly navigation: WorkspaceNavigationService,
    private readonly drafts: ComposerDraftService,
    private readonly clock: ClockPort,
    private readonly currentUserId: string
  ) {
    super();
    this.projectActivity = createAgentActivitySnapshotProjector(workspace.id);
    this.engine = createAgentSessionEngine({
      clock: { nowUnixMs: () => this.clock.now() },
      commandPort: {
        execute: (command, options) =>
          this.executeCommand(command, options?.signal)
      },
      identity: {
        origin: AGENT_SESSION_ENGINE_LOCAL_ORIGIN,
        workspaceId: workspace.id
      },
      scheduler: {
        schedule: (delayMs, task) => this.clock.schedule(delayMs, task)
      }
    });
    this.disposables.push(
      this.engine.subscribe(() => this.onDependencyChanged()),
      this.navigation.subscribe(() => {
        this.onDependencyChanged();
        void this.loadSelectedMessages(true);
      }),
      this.drafts.subscribe(() => this.onDependencyChanged()),
      this.directory.subscribe(() => {
        this.navigation.reconcileTargetIds(
          this.directory.getSnapshot().targets.map((target) => target.id)
        );
        this.onDependencyChanged();
      })
    );
  }

  getSnapshot = (): WorkspaceActivitySnapshot => {
    if (this.snapshotCache) return this.snapshotCache;
    const state = this.engine.getSnapshot();
    const activity = this.projectActivity(state);
    const navigation = this.navigation.getSnapshot();
    const sessions = selectRootAgentActivitySessions(activity).filter(
      (session) => session.visible
    );
    const selectedSession =
      sessions.find(
        (session) =>
          session.agentSessionId === navigation.selectedAgentSessionId
      ) ?? null;
    const draftKey = navigation.creating
      ? "new"
      : (navigation.selectedAgentSessionId ?? "none");
    const sending =
      Object.values(state.pendingIntents.submitsByClientSubmitId).some(
        (record) =>
          record.agentSessionId === navigation.selectedAgentSessionId &&
          (record.status === "requested" || record.status === "accepted")
      ) ||
      Object.values(state.pendingIntents.activationsByRequestId).some(
        (record) =>
          (navigation.creating ||
            record.agentSessionId === navigation.selectedAgentSessionId) &&
          (record.status === "requested" || record.status === "confirmed")
      );
    this.snapshotCache = {
      activity,
      ambiguousSubmission: this.ambiguousDraftKeys.has(draftKey),
      creating: navigation.creating,
      draft: this.drafts.get(draftKey),
      errorCode: this.errorCode,
      loading: this.loading,
      selectedAgentSessionId: navigation.selectedAgentSessionId,
      selectedAgentTargetId: navigation.selectedAgentTargetId,
      selectedSession,
      sending,
      targets: this.directory.getSnapshot().targets
    };
    return this.snapshotCache;
  };

  start(): Promise<void> {
    if (this.initializePromise) return this.initializePromise;
    if (this.disposed) return Promise.resolve();
    this.engine.dispatch({
      status: "connected",
      type: "engine/connectionChanged",
      workspaceId: this.workspace.id
    });
    for (const session of this.getSnapshot().activity.sessions) {
      this.engine.dispatch({
        agentSessionId: session.agentSessionId,
        availability: { state: "available" },
        type: "session/runtimeAvailabilityChanged"
      });
    }
    this.initializePromise = Promise.all([
      this.directory.load(),
      this.loadSessions(true)
    ])
      .then(() => undefined)
      .finally(() => {
        if (this.disposed) return;
        this.loading = false;
        this.onDependencyChanged();
      });
    return this.initializePromise;
  }

  setDraft(value: string): void {
    const navigation = this.navigation.getSnapshot();
    this.drafts.set(
      navigation.creating
        ? "new"
        : (navigation.selectedAgentSessionId ?? "none"),
      value
    );
  }

  selectSession(agentSessionId: string): void {
    this.navigation.selectSession(agentSessionId);
  }

  selectTarget(agentTargetId: string): void {
    this.navigation.selectTarget(agentTargetId);
  }

  startCreating(): void {
    const targets = this.directory.getSnapshot().targets;
    this.navigation.startCreating(targets.length === 1 ? targets[0]!.id : null);
  }

  async send(): Promise<void> {
    const snapshot = this.getSnapshot();
    const text = snapshot.draft.trim();
    if (!text || snapshot.sending) return;
    if (snapshot.creating && !snapshot.selectedAgentTargetId) return;
    const draftKey = snapshot.creating
      ? "new"
      : (snapshot.selectedAgentSessionId ?? "none");
    const submission = resolvePendingSubmission(
      this.pendingSubmissionsByDraftKey.get(draftKey) ?? null,
      {
        agentSessionId: snapshot.selectedAgentSessionId,
        agentTargetId: snapshot.selectedAgentTargetId,
        creating: snapshot.creating,
        text
      }
    );
    if (this.ambiguousDraftKeys.has(draftKey)) {
      await this.reconcileWorkspace().catch(() => undefined);
      this.reconcilePendingSubmissions();
      if (!this.pendingSubmissionsByDraftKey.has(draftKey)) return;
      this.dismissPendingSubmission(submission);
      this.ambiguousDraftKeys.delete(draftKey);
      this.errorCode = null;
    }
    this.pendingSubmissionsByDraftKey.set(draftKey, submission);
    const now = this.clock.now();
    const content = [{ text, type: "text" as const }];
    const submitDiagnostics = {
      blockCount: 1,
      promptLength: text.length,
      source: "mobile",
      submittedAtUnixMs: now
    };
    if (snapshot.creating) {
      this.engine.dispatch({
        agentSessionId: submission.agentSessionId,
        agentTargetId: submission.agentTargetId!,
        clientSubmitId: submission.clientSubmitId,
        content,
        expiresAtUnixMs: now + PENDING_EXPIRY_MS,
        initialTurnExpected: true,
        mode: "new",
        requestId: submission.clientSubmitId,
        requestedAtUnixMs: now,
        runtimeContent: content,
        submitDiagnostics,
        type: "activation/requested",
        visible: true,
        workspaceId: this.workspace.id
      });
      this.drafts.clear("new");
      return;
    }
    if (!snapshot.selectedAgentSessionId) return;
    this.engine.dispatch({
      agentSessionId: snapshot.selectedAgentSessionId,
      clientSubmitId: submission.clientSubmitId,
      content,
      expiresAtUnixMs: now + PENDING_EXPIRY_MS,
      requestedAtUnixMs: now,
      routing: "auto",
      runtimeContent: content,
      submitDiagnostics,
      type: "submit/requested",
      workspaceId: this.workspace.id
    });
    this.drafts.clear(snapshot.selectedAgentSessionId);
  }

  stop(): void {
    const selected = this.getSnapshot().selectedSession;
    if (!selected) return;
    const now = this.clock.now();
    this.engine.dispatch({
      agentSessionId: selected.agentSessionId,
      awaitingTurnExpiresAtUnixMs: now + PENDING_EXPIRY_MS,
      commandId: createMobileActivityCommandId(),
      timeoutMs: COMMAND_TIMEOUT_MS,
      type: "session/stopRequested",
      workspaceId: this.workspace.id
    });
  }

  respondToInteraction(
    interaction: AgentActivityInteraction,
    input: {
      action?: string;
      optionId?: string;
      payload?: Readonly<Record<string, unknown>>;
    }
  ): void {
    this.engine.dispatch({
      ...input,
      agentSessionId: interaction.agentSessionId,
      commandId: createMobileActivityCommandId(),
      requestId: interaction.requestId,
      retry: false,
      timeoutMs: COMMAND_TIMEOUT_MS,
      turnId: interaction.turnId,
      type: "interaction/responseRequested",
      workspaceId: this.workspace.id
    });
  }

  async loadOlderMessages(): Promise<void> {
    const selected = this.navigation.getSnapshot().selectedAgentSessionId;
    if (!selected || this.messagesInFlight || this.paused || this.disposed)
      return;
    const window = this.projectActivity(this.engine.getSnapshot())
      .sessionMessageWindowsById?.[selected];
    if (!window?.hasOlderMessages || window.oldestLoadedVersion === null)
      return;
    await this.loadMessagePage(selected, {
      beforeVersion: window.oldestLoadedVersion,
      limit: MESSAGE_PAGE_SIZE,
      order: "desc"
    });
  }

  pause(): void {
    if (this.paused || this.disposed) return;
    this.paused = true;
    this.cancelPolls();
    this.engine.dispatch({
      status: "disconnected",
      type: "engine/connectionChanged",
      workspaceId: this.workspace.id
    });
    for (const session of this.getSnapshot().activity.sessions) {
      this.engine.dispatch({
        agentSessionId: session.agentSessionId,
        availability: {
          reason: "transport_unavailable",
          state: "blocked"
        },
        type: "session/runtimeAvailabilityChanged"
      });
    }
  }

  resume(): void {
    if (!this.paused || this.disposed) return;
    this.paused = false;
    this.engine.dispatch({
      status: "connected",
      type: "engine/connectionChanged",
      workspaceId: this.workspace.id
    });
    this.engine.dispatch({
      type: "workspace/reconcileRequested",
      workspaceId: this.workspace.id
    });
    void this.loadSelectedMessages(true);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelPolls();
    for (const dispose of this.disposables.splice(0)) dispose();
    this.pendingSubmissionsByDraftKey.clear();
    this.ambiguousDraftKeys.clear();
    this.engine.dispose();
    this.clearListeners();
  }

  private async loadSessions(authoritative: boolean): Promise<void> {
    if (this.sessionsInFlight || this.paused || this.disposed) {
      return this.sessionsInFlight ?? Promise.resolve();
    }
    this.sessionsInFlight = this.client
      .listWorkspaceAgentSessions(this.workspace.id, { limit: 100 })
      .then((response) => {
        if (this.disposed || this.paused) return;
        const sessions = response.sessions.map((session) =>
          this.mapSession(session)
        );
        this.applySessionSnapshot(sessions);
        this.errorCode = null;
        if (authoritative) void this.loadSelectedMessages(true);
      })
      .catch(() => {
        if (!this.disposed) this.errorCode = "request_failed";
      })
      .finally(() => {
        this.sessionsInFlight = null;
        this.onDependencyChanged();
        this.scheduleSessionsPoll();
      });
    return this.sessionsInFlight;
  }

  private async loadSelectedMessages(authoritative: boolean): Promise<void> {
    const agentSessionId = this.navigation.getSnapshot().selectedAgentSessionId;
    if (
      !agentSessionId ||
      this.messagesInFlight ||
      this.paused ||
      this.disposed
    )
      return;
    const activity = this.projectActivity(this.engine.getSnapshot());
    const messages = activity.sessionMessagesById[agentSessionId] ?? [];
    const latestVersion = messages.reduce(
      (latest, message) => Math.max(latest, message.version),
      0
    );
    if (authoritative || latestVersion === 0) {
      await this.loadMessagePage(agentSessionId, {
        limit: MESSAGE_PAGE_SIZE,
        order: "desc"
      });
      return;
    }
    await this.loadMessagePage(agentSessionId, {
      afterVersion: latestVersion,
      order: "asc"
    });
  }

  private async loadMessagePage(
    agentSessionId: string,
    query: {
      afterVersion?: number;
      beforeVersion?: number;
      limit?: number;
      order: "asc" | "desc";
    }
  ): Promise<void> {
    if (this.messagesInFlight || this.paused || this.disposed) return;
    this.messagesInFlight = this.client
      .listWorkspaceAgentSessionMessages(
        this.workspace.id,
        agentSessionId,
        query
      )
      .then((page) => {
        if (
          this.disposed ||
          this.paused ||
          this.navigation.getSnapshot().selectedAgentSessionId !==
            agentSessionId
        )
          return;
        const messages = page.messages.map((message) =>
          agentActivityMessageFromTuttidMessage(this.workspace.id, message)
        );
        this.engine.dispatch({
          messages,
          ...(query.order === "desc"
            ? {
                sessionMessageWindows: [
                  {
                    agentSessionId,
                    ...agentActivitySessionMessageWindowFromDescendingPage({
                      ...page,
                      messages
                    })
                  }
                ]
              }
            : {}),
          type: "message/snapshotReceived",
          workspaceId: this.workspace.id
        });
        this.errorCode = null;
      })
      .catch(() => {
        if (!this.disposed) this.errorCode = "request_failed";
      })
      .finally(() => {
        this.messagesInFlight = null;
        this.onDependencyChanged();
        this.scheduleMessagesPoll();
      });
    return this.messagesInFlight;
  }

  private executeCommand(
    command: EngineExternalCommand,
    signal?: AbortSignal
  ): Promise<unknown> {
    switch (command.type) {
      case "engine/probe":
        return Promise.resolve({ ok: true });
      case "engine/reconcileWorkspace":
        return this.reconcileWorkspace();
      case "session/activate":
        return this.activateSession(command, signal);
      case "queue/sendPrompt":
        return this.sendPrompt(command);
      case "turn/cancel":
        return this.client
          .cancelWorkspaceAgentTurn(
            command.workspaceId,
            command.agentSessionId,
            command.turnId
          )
          .then((response) => ({
            ...response,
            ...(response.turn
              ? { turn: agentActivityTurnFromTuttidTurn(response.turn) }
              : {})
          }));
      case "interaction/respond":
        return this.client
          .submitWorkspaceAgentInteractive(
            command.workspaceId,
            command.agentSessionId,
            command.requestId,
            {
              action: command.action ?? null,
              optionId: command.optionId ?? null,
              payload: command.payload ?? null,
              turnId: command.turnId
            }
          )
          .then((session) => ({
            session: this.mapSession(session)
          }));
      case "session/reconcile":
        return this.reconcileSession(command.agentSessionId);
      default:
        return Promise.reject(
          new Error(`unsupported mobile agent command: ${command.type}`)
        );
    }
  }

  private async activateSession(
    command: SessionActivateCommand,
    signal?: AbortSignal
  ): Promise<unknown> {
    if (command.mode === "existing") {
      if (signal?.aborted) throw signal.reason;
      const detail = await this.client.getWorkspaceAgentSession(
        command.workspaceId,
        command.agentSessionId
      );
      const session = this.mapSession(detail.session);
      this.engine.dispatch({ session, type: "session/upserted" });
      return {
        activation: { mode: "existing", status: "already_attached" },
        session
      };
    }
    const session = await this.client.createWorkspaceAgentSession(
      command.workspaceId,
      {
        agentSessionId: command.agentSessionId,
        agentTargetId: command.agentTargetId,
        clientSubmitId: command.clientSubmitId,
        cwd: command.cwd ?? null,
        initialContent: toTuttidPromptContent(command.initialContent ?? []),
        initialDisplayPrompt: command.initialDisplayPrompt ?? null,
        submitDiagnostics: command.submitDiagnostics,
        title: command.title ?? null,
        visible: command.visible ?? true
      },
      { signal }
    );
    const activitySession = this.mapSession(session);
    this.engine.dispatch({
      session: activitySession,
      type: "session/upserted"
    });
    return {
      activation: { mode: "new", status: "attached" },
      session: activitySession
    };
  }

  private async sendPrompt(command: PromptQueueSendCommand): Promise<unknown> {
    const result = await this.client.sendWorkspaceAgentSessionInput(
      command.workspaceId,
      command.agentSessionId,
      {
        clientSubmitId: command.clientSubmitId,
        content: toTuttidPromptContent(command.content),
        displayPrompt: command.displayPrompt ?? null,
        guidance: command.guidance ?? false,
        submitDiagnostics: command.submitDiagnostics
      }
    );
    if (result.kind === "goalControl") {
      return {
        kind: "goalControl",
        goal: result.goal ?? result.session.goal ?? null,
        session: this.mapSession(result.session)
      };
    }
    return {
      kind: "turn",
      session: this.mapSession(result.session),
      turn: agentActivityTurnFromTuttidTurn(result.turn),
      turnId: result.turnId
    };
  }

  private async reconcileWorkspace(): Promise<unknown> {
    await this.sessionsInFlight;
    const response = await this.client.listWorkspaceAgentSessions(
      this.workspace.id,
      { limit: 100 }
    );
    const sessions = response.sessions.map((session) =>
      this.mapSession(session)
    );
    if (this.disposed || this.paused) {
      throw new Error("mobile workspace activity is unavailable");
    }
    this.applySessionSnapshot(sessions);
    this.errorCode = null;
    void this.loadSelectedMessages(true);
    return { sessions };
  }

  private async reconcileSession(agentSessionId: string): Promise<unknown> {
    const detail = await this.client.getWorkspaceAgentSession(
      this.workspace.id,
      agentSessionId
    );
    const session = this.mapSession(detail.session);
    this.engine.dispatch({ session, type: "session/upserted" });
    for (const turn of detail.turns) {
      this.engine.dispatch({
        turn: agentActivityTurnFromTuttidTurn(turn),
        type: "turn/upserted"
      });
    }
    await this.loadSelectedMessages(true);
    return { session };
  }

  private scheduleSessionsPoll(): void {
    this.sessionPollTask?.cancel();
    if (this.disposed || this.paused) return;
    this.sessionPollTask = this.clock.schedule(SESSION_POLL_MS, () => {
      this.sessionPollTask = null;
      void this.loadSessions(false);
    });
  }

  private scheduleMessagesPoll(): void {
    this.messagePollTask?.cancel();
    if (this.disposed || this.paused) return;
    this.messagePollTask = this.clock.schedule(MESSAGE_POLL_MS, () => {
      this.messagePollTask = null;
      void this.loadSelectedMessages(false);
    });
  }

  private cancelPolls(): void {
    this.sessionPollTask?.cancel();
    this.sessionPollTask = null;
    this.messagePollTask?.cancel();
    this.messagePollTask = null;
  }

  private applySessionSnapshot(sessions: AgentActivitySession[]): void {
    this.engine.dispatch({
      sessions,
      type: "session/snapshotReceived"
    });
    const roots = selectRootAgentActivitySessions({ sessions }).filter(
      (session) => session.visible
    );
    this.navigation.reconcileSessionIds(
      roots.map((session) => session.agentSessionId)
    );
  }

  private onDependencyChanged(): void {
    this.reconcilePendingSubmissions();
    this.snapshotCache = null;
    this.emitChange();
  }

  private reconcilePendingSubmissions(): void {
    const state = this.engine.getSnapshot();
    for (const [draftKey, submission] of this.pendingSubmissionsByDraftKey) {
      if (submission.creating) {
        const session =
          state.sessionLifecycle.sessionsById[submission.agentSessionId];
        if (session) {
          this.pendingSubmissionsByDraftKey.delete(draftKey);
          this.ambiguousDraftKeys.delete(draftKey);
          this.errorCode = null;
          this.drafts.clear(draftKey);
          this.navigation.selectSession(submission.agentSessionId);
          continue;
        }
        const record =
          state.pendingIntents.activationsByRequestId[
            submission.clientSubmitId
          ];
        if (record?.status === "failed" || record?.status === "uncertain") {
          this.markSubmissionAmbiguous(draftKey, submission.text);
        }
        continue;
      }
      const record =
        state.pendingIntents.submitsByClientSubmitId[submission.clientSubmitId];
      if (record?.status === "accepted" || record?.status === "confirmed") {
        this.pendingSubmissionsByDraftKey.delete(draftKey);
        this.ambiguousDraftKeys.delete(draftKey);
        this.errorCode = null;
      } else if (
        record?.status === "failed" ||
        record?.status === "uncertain"
      ) {
        this.markSubmissionAmbiguous(draftKey, submission.text);
      }
    }
  }

  private markSubmissionAmbiguous(draftKey: string, text: string): void {
    this.ambiguousDraftKeys.add(draftKey);
    this.errorCode = "request_failed";
    if (!this.drafts.get(draftKey)) {
      this.drafts.set(draftKey, text);
    }
  }

  private dismissPendingSubmission(submission: PendingSubmission): void {
    if (submission.creating) {
      this.engine.dispatch({
        requestId: submission.clientSubmitId,
        type: "activation/dismissed"
      });
      return;
    }
    this.engine.dispatch({
      clientSubmitId: submission.clientSubmitId,
      type: "submit/dismissed"
    });
  }

  private mapSession(
    session: Parameters<typeof agentActivitySessionFromTuttidSession>[1]
  ): AgentActivitySession {
    return agentActivitySessionFromTuttidSession(this.workspace.id, session, {
      currentUserId: this.currentUserId
    });
  }
}
