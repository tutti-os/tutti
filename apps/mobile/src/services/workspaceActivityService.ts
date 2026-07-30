import {
  AGENT_SESSION_ENGINE_LOCAL_ORIGIN,
  createAgentActivitySnapshotProjector,
  createAgentSessionEngine,
  selectEngineSessionRuntimeAvailability,
  type AgentActivitySessionSettings,
  type AgentActivityInteraction,
  type AgentActivitySessionReconcileExecutor,
  type AgentSessionEngine,
  type SessionReconcileCommand
} from "@tutti-os/agent-activity-core";
import type {
  TuttidClient,
  WorkspaceSummary
} from "@tutti-os/client-tuttid-ts";
import {
  createAgentConversationMessageController,
  type AgentConversationMessageController
} from "@tutti-os/agent-gui/conversation-message-controller";
import type { AgentDirectoryService } from "./agentDirectoryService";
import type { ComposerDraftService } from "./composerDraftService";
import { createMobileAgentActivityMapping } from "./mobileAgentActivityMapping";
import { createMobileAgentActivityReconcileExecutor } from "./mobileAgentActivityReconcileExecutor";
import { ObservableService } from "./observableService";
import {
  dismissPendingSubmission,
  resolvePendingSubmission,
  type PendingSubmission
} from "./pendingSubmission";
import type { ClockPort, DeviceLinkPort } from "./servicePorts";
import {
  createWorkspaceActivityEffectPort,
  executeWorkspaceActivityExtensionCommand
} from "./workspaceActivityEngineCommandPort";
import {
  projectWorkspaceActivitySnapshot,
  resolveWorkspaceComposerTarget
} from "./workspaceActivityProjection";
import { WorkspaceConversationRailService } from "./workspaceConversationRailService";
import type { WorkspaceActivitySnapshot } from "./workspaceActivityTypes";
import { WorkspaceAgentLiveLane } from "./workspaceAgentLiveLane";
import { selectWorkspaceConversationRailSessionIds } from "./workspaceConversationRailProjection";
import type { WorkspaceNavigationService } from "./workspaceNavigationService";
import { WorkspaceMediaService } from "./workspaceMediaService";

export type { WorkspaceActivitySnapshot } from "./workspaceActivityTypes";

const MESSAGE_POLL_MS = 1_000;
const PENDING_EXPIRY_MS = 60_000;

export class WorkspaceActivityService extends ObservableService<WorkspaceActivitySnapshot> {
  readonly _serviceBrand: undefined;
  readonly media: WorkspaceMediaService;
  readonly rail: WorkspaceConversationRailService;
  private readonly engine: AgentSessionEngine;
  private readonly liveLane: WorkspaceAgentLiveLane;
  private readonly messages: AgentConversationMessageController;
  private readonly mapping: ReturnType<typeof createMobileAgentActivityMapping>;
  private readonly sessionReconcileExecutor: AgentActivitySessionReconcileExecutor;
  private readonly projectActivity: (
    state: ReturnType<AgentSessionEngine["getSnapshot"]>
  ) => WorkspaceActivitySnapshot["activity"];
  private disposed = false;
  private paused = false;
  private initializePromise: Promise<void> | null = null;
  private messagePollTask: { cancel(): void } | null = null;
  private errorCode: "request_failed" | null = null;
  private loading = true;
  private observedSelectedSessionId: string | null = null;
  private previousConversation: WorkspaceActivitySnapshot["conversation"] =
    null;
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
    currentUserId: string,
    deviceLink?: DeviceLinkPort
  ) {
    super();
    this.media = new WorkspaceMediaService(workspace.id, client);
    this.mapping = createMobileAgentActivityMapping({
      currentUserId,
      workspaceId: workspace.id
    });
    this.projectActivity = createAgentActivitySnapshotProjector(workspace.id);
    const commandContext = () => ({
      client: this.client,
      engine: this.engine,
      mapSession: this.mapping.mapSession,
      mapSessionDetail: this.mapping.mapSessionDetail,
      reconcileSession: (
        reconcileCommand: SessionReconcileCommand,
        reconcileSignal?: AbortSignal
      ) =>
        this.executeSessionReconcileCommand(reconcileCommand, reconcileSignal),
      reconcileWorkspace: () => this.reconcileWorkspace()
    });
    this.engine = createAgentSessionEngine({
      clock: { nowUnixMs: () => this.clock.now() },
      commandPort: {
        kind: "typed",
        effects: createWorkspaceActivityEffectPort(commandContext),
        execute: (command, options): Promise<unknown> =>
          executeWorkspaceActivityExtensionCommand(
            commandContext(),
            command,
            options
          )
      },
      identity: {
        origin: AGENT_SESSION_ENGINE_LOCAL_ORIGIN,
        workspaceId: workspace.id
      },
      scheduler: {
        schedule: (delayMs, task) => this.clock.schedule(delayMs, task)
      }
    });
    this.rail = new WorkspaceConversationRailService(workspace, client, clock, {
      engine: this.engine,
      getActiveConversationId: () =>
        this.navigation.getSnapshot().selectedAgentSessionId,
      mapSession: this.mapping.mapSession
    });
    this.liveLane = new WorkspaceAgentLiveLane({
      clock: this.clock,
      deviceLink,
      engine: this.engine,
      isAvailable: () => !this.disposed && !this.paused,
      navigation: this.navigation,
      onActivityChanged: () => this.onDependencyChanged(),
      onConnectionChanged: (connected) => {
        if (connected) {
          this.messagePollTask?.cancel();
          this.messagePollTask = null;
        } else {
          this.scheduleMessagesPoll();
        }
      },
      rail: this.rail,
      readCanonicalActivity: () =>
        this.projectActivity(this.engine.getSnapshot()),
      workspaceId: this.workspace.id
    });
    this.sessionReconcileExecutor = createMobileAgentActivityReconcileExecutor({
      client: this.client,
      engine: this.engine,
      isAvailable: () => !this.disposed && !this.paused,
      isSessionDeleted: (agentSessionId) =>
        this.liveLane.isSessionDeleted(agentSessionId),
      mapping: this.mapping,
      reconcileAuthoritativeHistory: (agentSessionId, messages, turns) =>
        this.liveLane.reconcileAuthoritativeHistory(
          agentSessionId,
          messages,
          turns
        ),
      reconcileOptimisticMessages: (agentSessionId) =>
        this.liveLane.reconcileMessages(agentSessionId),
      workspaceId: this.workspace.id
    });
    this.messages = createAgentConversationMessageController({
      engine: this.engine,
      isAvailable: () => !this.disposed && !this.paused,
      listSessionMessages: async ({
        agentSessionId,
        beforeVersion,
        limit,
        order,
        signal
      }) => {
        const page = await this.client.listWorkspaceAgentSessionMessages(
          this.workspace.id,
          agentSessionId,
          { beforeVersion, limit, order },
          { signal }
        );
        return {
          ...page,
          messages: page.messages.map(this.mapping.mapMessage)
        };
      },
      onOlderPageApplied: (agentSessionId) => {
        this.liveLane.reconcileMessages(agentSessionId);
        this.errorCode = null;
      },
      onOlderPageFailed: () => {
        if (!this.disposed) this.errorCode = "request_failed";
      },
      onOlderPageSettled: () => {
        this.onDependencyChanged();
        this.scheduleMessagesPoll();
      },
      workspaceId: this.workspace.id
    });
    this.messages.setActiveSession(
      this.navigation.getSnapshot().selectedAgentSessionId
    );
    this.disposables.push(
      this.engine.subscribe(() => this.onDependencyChanged()),
      this.navigation.subscribe(() => {
        const selectedSessionId =
          this.navigation.getSnapshot().selectedAgentSessionId;
        const selectionChanged =
          selectedSessionId !== this.observedSelectedSessionId;
        this.observedSelectedSessionId = selectedSessionId;
        this.messages.setActiveSession(selectedSessionId);
        this.onDependencyChanged();
        if (selectionChanged) void this.loadSelectedMessages(true);
        this.loadComposerOptions();
      }),
      this.drafts.subscribe(() => this.onDependencyChanged()),
      this.rail.subscribe(() => {
        const rail = this.rail.getSnapshot();
        if (rail.status === "ready" && !this.disposed && !this.paused) {
          this.markRailSessionsAvailable(
            selectWorkspaceConversationRailSessionIds(rail.sections)
          );
          this.navigation.reconcileSessionIds(
            selectWorkspaceConversationRailSessionIds(rail.sections)
          );
        }
        this.onDependencyChanged();
      }),
      this.directory.subscribe(() => {
        this.navigation.reconcileTargetIds(
          this.directory.getSnapshot().targets.map((target) => target.id)
        );
        this.onDependencyChanged();
        this.loadComposerOptions();
      })
    );
  }

  getSnapshot = (): WorkspaceActivitySnapshot => {
    if (this.snapshotCache) return this.snapshotCache;
    const state = this.engine.getSnapshot();
    const activity = this.liveLane.project(this.projectActivity(state));
    const railSnapshot = this.rail.getSnapshot();
    const navigation = this.navigation.getSnapshot();
    const draftKey = navigation.creating
      ? "new"
      : (navigation.selectedAgentSessionId ?? "none");
    const draftSettings = navigation.creating
      ? this.drafts.getSettings(navigation.selectedAgentTargetId ?? "")
      : {};
    this.snapshotCache = projectWorkspaceActivitySnapshot({
      activity,
      ambiguousSubmission: this.ambiguousDraftKeys.has(draftKey),
      draftSettings,
      draft: this.drafts.get(draftKey),
      errorCode: this.errorCode,
      loading: this.loading,
      navigation,
      previousConversation: this.previousConversation,
      rail: railSnapshot,
      state,
      targets: this.directory.getSnapshot().targets,
      workspaceId: this.workspace.id
    });
    this.previousConversation = this.snapshotCache.conversation;
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
      this.rail.start()
    ])
      .then(() => undefined)
      .finally(() => {
        if (this.disposed) return;
        this.loading = false;
        this.loadComposerOptions();
        this.liveLane.start();
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

  updateComposerSettings(settings: AgentActivitySessionSettings): void {
    if (!this.getSnapshot().commandsAvailable) return;
    const target = this.currentComposerTarget();
    if (!target || Object.keys(settings).length === 0) return;
    const navigation = this.navigation.getSnapshot();
    if (navigation.creating) {
      this.drafts.setSettings(target.agentTargetId, settings);
      this.loadComposerOptions({ force: true });
      return;
    }
    if (!target.agentSessionId) return;
    this.engine.updateSessionSettings({
      agentSessionId: target.agentSessionId,
      settings
    });
  }

  startCreating(): void {
    const targets = this.directory.getSnapshot().targets;
    this.navigation.startCreating(targets.length === 1 ? targets[0]!.id : null);
  }

  loadMoreSessions(sectionId: string): Promise<void> {
    return this.rail.loadMore(sectionId);
  }

  refreshSessions(): Promise<void> {
    return this.rail.refresh();
  }

  async toggleSessionPinned(agentSessionId: string): Promise<void> {
    const session = this.getSnapshot().activity.sessions.find(
      (candidate) => candidate.agentSessionId === agentSessionId
    );
    if (!session) return;
    try {
      await this.engine.setSessionPinned({
        agentSessionId,
        pinned: session.pinnedAtUnixMs == null
      });
      await this.rail.reconcile();
      this.errorCode = null;
    } catch {
      if (!this.disposed) this.errorCode = "request_failed";
    }
    this.onDependencyChanged();
  }

  async renameSession(agentSessionId: string, title: string): Promise<void> {
    const normalizedTitle = title.trim();
    if (!normalizedTitle) return;
    try {
      await this.engine.renameSession({
        agentSessionId,
        title: normalizedTitle
      });
      this.errorCode = null;
    } catch {
      if (!this.disposed) this.errorCode = "request_failed";
    }
    this.onDependencyChanged();
  }

  async deleteSession(agentSessionId: string): Promise<void> {
    try {
      await this.engine.deleteSessions({
        agentSessionIds: [agentSessionId]
      });
      await this.rail.reconcile();
      this.errorCode = null;
    } catch {
      if (!this.disposed) this.errorCode = "request_failed";
    }
    this.onDependencyChanged();
  }

  async send(): Promise<void> {
    const snapshot = this.getSnapshot();
    const text = snapshot.draft.trim();
    if (!text || snapshot.sending || !snapshot.commandsAvailable) return;
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
      dismissPendingSubmission(this.engine, submission);
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
        settings: snapshot.composerSettings,
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
    const snapshot = this.getSnapshot();
    if (!snapshot.commandsAvailable) return;
    const selected = snapshot.selectedSession;
    if (!selected) return;
    this.engine.stopSession({
      agentSessionId: selected.agentSessionId
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
    this.engine.submitInteractionResponse({
      agentSessionId: interaction.agentSessionId,
      requestId: interaction.requestId,
      turnId: interaction.turnId,
      ...(input.action ? { action: input.action } : {}),
      ...(input.optionId ? { optionId: input.optionId } : {}),
      ...(input.payload ? { payload: input.payload } : {})
    });
  }

  async loadOlderMessages(): Promise<void> {
    await this.messages.loadOlder();
  }

  pause(): void {
    if (this.paused || this.disposed) return;
    this.paused = true;
    this.messages.cancel();
    this.liveLane.stop();
    this.cancelPolls();
    this.rail.pause();
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
    this.rail.resume();
    this.liveLane.start();
    this.engine.dispatch({
      status: "connected",
      type: "engine/connectionChanged",
      workspaceId: this.workspace.id
    });
    for (const session of this.projectActivity(this.engine.getSnapshot())
      .sessions) {
      this.engine.dispatch({
        agentSessionId: session.agentSessionId,
        availability: { state: "available" },
        type: "session/runtimeAvailabilityChanged"
      });
    }
    this.engine.dispatch({
      retry: true,
      type: "workspace/reconcileRequested",
      workspaceId: this.workspace.id
    });
    const selectedSessionId =
      this.navigation.getSnapshot().selectedAgentSessionId;
    if (selectedSessionId) {
      this.engine.dispatch({
        agentSessionId: selectedSessionId,
        needsMessages: true,
        needsState: true,
        type: "session/reconcileRequested",
        workspaceId: this.workspace.id
      });
    }
    this.scheduleMessagesPoll();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.messages.dispose();
    this.liveLane.dispose();
    this.cancelPolls();
    for (const dispose of this.disposables.splice(0)) dispose();
    this.rail.dispose();
    this.pendingSubmissionsByDraftKey.clear();
    this.ambiguousDraftKeys.clear();
    this.engine.dispose();
    this.media.dispose();
    this.clearListeners();
  }

  private async loadSelectedMessages(authoritative: boolean): Promise<void> {
    const agentSessionId = this.navigation.getSnapshot().selectedAgentSessionId;
    if (!agentSessionId || this.paused || this.disposed) return;
    try {
      await this.loadSessionMessages(agentSessionId, authoritative);
    } catch {
      // Background and presentation-driven loads surface the recorded error in
      // the workspace snapshot. Engine-owned reconcile commands call the same
      // primitive directly and retain the rejection for canonical retry state.
    }
  }

  private async loadSessionMessages(
    agentSessionId: string,
    authoritative: boolean
  ): Promise<void> {
    if (authoritative) {
      this.messages.requestInitial(agentSessionId);
      return;
    }
    this.messages.requestLatest(agentSessionId);
  }

  private async reconcileWorkspace(): Promise<unknown> {
    const rail = await this.rail.reconcile();
    if (this.disposed || this.paused) {
      throw new Error("mobile workspace activity is unavailable");
    }
    this.errorCode = null;
    return {
      sessionIds: selectWorkspaceConversationRailSessionIds(rail.sections)
    };
  }

  private async executeSessionReconcileCommand(
    command: SessionReconcileCommand,
    signal?: AbortSignal
  ): Promise<unknown> {
    const reconcilesMessages = command.scope !== "state";
    try {
      const result = await this.sessionReconcileExecutor.execute(command, {
        signal
      });
      if (reconcilesMessages) {
        this.errorCode = null;
        this.onDependencyChanged();
        this.scheduleMessagesPoll();
      }
      return result;
    } catch (error: unknown) {
      if (reconcilesMessages && !this.disposed && !this.paused) {
        this.errorCode = "request_failed";
        this.onDependencyChanged();
        this.scheduleMessagesPoll();
      }
      throw error;
    }
  }

  private loadComposerOptions(options?: { force?: boolean }): void {
    if (this.disposed || this.paused) return;
    const target = this.currentComposerTarget();
    if (!target) return;
    void this.engine
      .loadComposerOptions({
        ...(target.cwd ? { cwd: target.cwd } : {}),
        ...(options?.force ? { force: true } : {}),
        provider: target.provider,
        settings: target.settings,
        targetKey: target.agentTargetId
      })
      .catch(() => undefined);
  }

  private currentComposerTarget() {
    return resolveWorkspaceComposerTarget({
      activity: this.projectActivity(this.engine.getSnapshot()),
      getDraftSettings: (agentTargetId) =>
        this.drafts.getSettings(agentTargetId),
      navigation: this.navigation.getSnapshot(),
      targets: this.directory.getSnapshot().targets
    });
  }

  private scheduleMessagesPoll(): void {
    this.messagePollTask?.cancel();
    if (this.disposed || this.paused || this.liveLane.isConnected()) return;
    this.messagePollTask = this.clock.schedule(MESSAGE_POLL_MS, () => {
      this.messagePollTask = null;
      void this.loadSelectedMessages(false);
    });
  }

  private cancelPolls(): void {
    this.messagePollTask?.cancel();
    this.messagePollTask = null;
  }

  private markRailSessionsAvailable(agentSessionIds: readonly string[]): void {
    const state = this.engine.getSnapshot();
    for (const agentSessionId of agentSessionIds) {
      if (
        selectEngineSessionRuntimeAvailability(state, agentSessionId)?.state ===
        "available"
      ) {
        continue;
      }
      this.engine.dispatch(
        {
          agentSessionId,
          availability: { state: "available" },
          type: "session/runtimeAvailabilityChanged"
        },
        { batch: true }
      );
    }
  }

  private onDependencyChanged(): void {
    this.reconcilePendingSubmissions();
    this.snapshotCache = null;
    this.media.sync(this.getSnapshot().conversation);
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
}
