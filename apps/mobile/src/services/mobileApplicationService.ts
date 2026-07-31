import type {
  TuttidClient,
  WorkspaceSummary
} from "@tutti-os/client-tuttid-ts";
import {
  ServiceCollection,
  type IInstantiationService
} from "@tutti-os/infra/di";
import type { AccountSession } from "./mobileDomain";
import { AgentDirectoryService } from "./agentDirectoryService";
import { ComposerDraftService } from "./composerDraftService";
import {
  DeviceConnectionSetupError,
  DeviceService,
  type ConnectedDevice
} from "./deviceService";
import { LoginService } from "./loginService";
import {
  IAgentDirectoryService,
  IComposerDraftService,
  IDeviceService,
  ILoginService,
  IMobileQuickPromptLibraryService,
  IWorkspaceActivityService,
  IWorkspaceConversationRailService,
  IWorkspaceMediaService,
  IWorkspaceNavigationService
} from "./mobileServiceIdentifiers";
import { ObservableService } from "./observableService";
import { MobileQuickPromptLibraryService } from "./mobileQuickPromptLibraryService";
import type { AppLifecycleState, MobileServicePorts } from "./servicePorts";
import { WorkspaceActivityService } from "./workspaceActivityService";
import { WorkspaceCatalogService } from "./workspaceCatalogService";
import type { WorkspaceConversationRailService } from "./workspaceConversationRailService";
import { WorkspaceNavigationService } from "./workspaceNavigationService";

const BACKGROUND_GRACE_MS = 15_000;
const CONNECTION_READY_TIMEOUT_MS = 15_000;
const TRANSPORT_RECOVERY_GRACE_MS = 1_500;

export type MobileConnectionRecoveryTrigger =
  | "background_expired"
  | "foreground_resume"
  | "initial_connect"
  | "manual_retry"
  | "transport_lost";

export type MobileConnectionSnapshot =
  | { phase: "idle" }
  | { phase: "connected" }
  | {
      phase: "failed" | "reconnecting" | "synchronizing";
      trigger: MobileConnectionRecoveryTrigger;
    };

export type MobileApplicationSnapshot =
  | { status: "bootstrapping" }
  | { status: "unauthenticated" }
  | {
      status: "authenticated";
      device: ConnectedDevice | null;
      connection: MobileConnectionSnapshot;
      session: AccountSession;
      workspace: WorkspaceSummary | null;
    };

interface AuthenticatedScope {
  client: TuttidClient;
  container: IInstantiationService;
  device: ConnectedDevice | null;
  deviceService: DeviceService;
  directory: AgentDirectoryService;
  quickPrompts: MobileQuickPromptLibraryService;
  session: AccountSession;
  workspaceCatalog: WorkspaceCatalogService;
}

interface WorkspaceScope {
  activity: WorkspaceActivityService;
  container: IInstantiationService;
  drafts: ComposerDraftService;
  generation: number;
  navigation: WorkspaceNavigationService;
  rail: WorkspaceConversationRailService;
  workspace: WorkspaceSummary;
}

export class MobileApplicationService extends ObservableService<MobileApplicationSnapshot> {
  readonly _serviceBrand: undefined;
  private snapshot: MobileApplicationSnapshot = { status: "bootstrapping" };
  private loginScope: {
    container: IInstantiationService;
    service: LoginService;
  } | null = null;
  private authenticatedScope: AuthenticatedScope | null = null;
  private workspaceScope: WorkspaceScope | null = null;
  private workspaceCandidate: WorkspaceScope | null = null;
  private lifecycleDispose: (() => void) | null = null;
  private connectionReadyTask: { cancel(): void } | null = null;
  private transportRecoveryTask: { cancel(): void } | null = null;
  private deviceDisconnectTask: Promise<void> | null = null;
  private deviceReconnectTask: Promise<void> | null = null;
  private deviceLinkCloseTask: Promise<void> | null = null;
  private backgroundStartedAtUnixMs: number | null = null;
  private appForeground = true;
  private startPromise: Promise<void> | null = null;
  private connectionRecoveryGeneration = 0;
  private workspaceGeneration = 0;
  private disposed = false;

  constructor(
    private readonly rootContainer: IInstantiationService,
    private readonly ports: MobileServicePorts
  ) {
    super();
  }

  getSnapshot = (): MobileApplicationSnapshot => this.snapshot;

  get loginService(): LoginService | null {
    return this.loginScope?.service ?? null;
  }

  get deviceService(): DeviceService | null {
    return this.authenticatedScope?.deviceService ?? null;
  }

  get quickPromptLibraryService(): MobileQuickPromptLibraryService | null {
    return this.authenticatedScope?.quickPrompts ?? null;
  }

  get workspaceActivityService(): WorkspaceActivityService | null {
    return this.workspaceScope?.activity ?? null;
  }

  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.lifecycleDispose = this.ports.appLifecycle.subscribe((state) =>
      this.handleAppLifecycle(state)
    );
    this.startPromise = this.ports.legacySessionCookie
      .clear()
      .catch(() => undefined)
      .then(() => this.ports.sessionStorage.loadSession())
      .then(async (session) => {
        if (this.disposed) return;
        if (session) {
          this.enterAuthenticated(session);
        } else {
          this.enterUnauthenticated();
        }
      })
      .catch(() => {
        if (!this.disposed) this.enterUnauthenticated();
      });
    return this.startPromise;
  }

  async signOut(): Promise<void> {
    await this.closeDeviceLink();
    await Promise.all([
      this.ports.sessionStorage.clearSession(),
      this.ports.legacySessionCookie.clear().catch(() => undefined)
    ]);
    this.disposeAuthenticatedScope();
    this.enterUnauthenticated();
  }

  disconnectDevice(): Promise<void> {
    if (this.deviceDisconnectTask) return this.deviceDisconnectTask;
    this.cancelConnectionRecovery();
    const scope = this.authenticatedScope;
    const task = this.closeDeviceLink().finally(() => {
      if (this.deviceDisconnectTask === task) {
        this.deviceDisconnectTask = null;
      }
      if (
        scope &&
        this.authenticatedScope === scope &&
        scope.device === null &&
        this.appForeground
      ) {
        scope.deviceService.resumeRemoteOperations();
      }
    });
    this.deviceDisconnectTask = task;
    scope?.deviceService.suspendRemoteOperations();
    if (scope) this.clearConnectedDevice(scope);
    return task;
  }

  retryDeviceConnection(): Promise<void> {
    return this.recoverDeviceConnection("manual_retry");
  }

  private async selectWorkspace(
    workspace: WorkspaceSummary,
    trigger: MobileConnectionRecoveryTrigger
  ): Promise<boolean> {
    const authenticated = this.authenticatedScope;
    if (!authenticated?.device) return false;
    const previousCandidate = this.workspaceCandidate;
    this.workspaceCandidate = null;
    previousCandidate?.container.dispose();
    const generation = ++this.workspaceGeneration;
    const previousWorkspace =
      this.workspaceScope?.workspace.id === workspace.id
        ? this.workspaceScope
        : null;
    const navigation = new WorkspaceNavigationService(
      previousWorkspace?.navigation.getSnapshot()
    );
    const drafts = new ComposerDraftService(
      previousWorkspace?.drafts.getSnapshot()
    );
    const activity = new WorkspaceActivityService(
      workspace,
      authenticated.client,
      authenticated.directory,
      navigation,
      drafts,
      this.ports.clock,
      authenticated.session.userId,
      this.ports.deviceLink,
      (connected) =>
        this.handleWorkspaceTransportConnectionChanged(generation, connected)
    );
    const rail = activity.rail;
    const services = new ServiceCollection();
    services.set(IWorkspaceNavigationService, navigation);
    services.set(IComposerDraftService, drafts);
    services.set(IWorkspaceConversationRailService, rail);
    services.set(IWorkspaceActivityService, activity);
    services.set(IWorkspaceMediaService, activity.media);
    const container = authenticated.container.createChild(services);
    const candidate: WorkspaceScope = {
      activity,
      container,
      drafts,
      generation,
      navigation,
      rail,
      workspace
    };
    this.workspaceCandidate = candidate;
    try {
      await activity.start();
      if (
        this.disposed ||
        this.authenticatedScope !== authenticated ||
        authenticated.device === null ||
        generation !== this.workspaceGeneration
      ) {
        if (this.workspaceCandidate === candidate) {
          this.workspaceCandidate = null;
          candidate.container.dispose();
        }
        return false;
      }
      this.workspaceCandidate = null;
      const previousScope = this.workspaceScope;
      this.workspaceScope = candidate;
      previousScope?.container.dispose();
      const connection: MobileConnectionSnapshot =
        candidate.activity.isTransportConnected()
          ? { phase: "connected" }
          : { phase: "synchronizing", trigger };
      this.publishAuthenticated(authenticated, connection, workspace);
      if (connection.phase === "synchronizing") {
        this.scheduleConnectionReadyDeadline(candidate, trigger);
      }
      return true;
    } catch {
      if (this.workspaceCandidate === candidate) {
        this.workspaceCandidate = null;
        candidate.container.dispose();
      }
      return false;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelConnectionRecovery();
    this.lifecycleDispose?.();
    this.lifecycleDispose = null;
    this.disposeWorkspaceScope();
    this.disposeAuthenticatedScope();
    this.disposeLoginScope();
    this.clearListeners();
  }

  private enterUnauthenticated(): void {
    this.disposeLoginScope();
    const service = new LoginService(this.ports.account, async (session) => {
      await this.ports.sessionStorage.saveSession(
        session.sessionId,
        session.userId,
        session.email,
        session.name
      );
      this.disposeLoginScope();
      this.enterAuthenticated(session);
    });
    const services = new ServiceCollection();
    services.set(ILoginService, service);
    this.loginScope = {
      container: this.rootContainer.createChild(services),
      service
    };
    this.publish({ status: "unauthenticated" });
  }

  private enterAuthenticated(session: AccountSession): void {
    this.disposeAuthenticatedScope();
    const client = this.ports.createRemoteClient();
    const directory = new AgentDirectoryService(client);
    const quickPrompts = new MobileQuickPromptLibraryService(client);
    const workspaceCatalog = new WorkspaceCatalogService(client);
    const deviceService = new DeviceService(
      session,
      this.ports.pairing,
      this.ports.qrCodeScanner,
      this.ports.diagnostics,
      this.ports.clock,
      (device) => this.onDeviceConnected(device)
    );
    if (!this.appForeground) {
      deviceService.suspendRemoteOperations();
    }
    const services = new ServiceCollection();
    services.set(IDeviceService, deviceService);
    services.set(IAgentDirectoryService, directory);
    services.set(IMobileQuickPromptLibraryService, quickPrompts);
    const container = this.rootContainer.createChild(services);
    this.authenticatedScope = {
      client,
      container,
      device: null,
      deviceService,
      directory,
      quickPrompts,
      session,
      workspaceCatalog
    };
    this.publish({
      connection: { phase: "idle" },
      device: null,
      session,
      status: "authenticated",
      workspace: null
    });
    deviceService.start();
  }

  private async onDeviceConnected(device: ConnectedDevice): Promise<void> {
    const scope = this.authenticatedScope;
    if (!scope) return;
    const current =
      this.snapshot.status === "authenticated" ? this.snapshot : null;
    const preservingWorkspace = Boolean(
      current?.device &&
      current.workspace &&
      current.device.pairingId === device.pairingId
    );
    const trigger: MobileConnectionRecoveryTrigger =
      current?.connection.phase === "reconnecting" ||
      current?.connection.phase === "synchronizing" ||
      current?.connection.phase === "failed"
        ? current.connection.trigger
        : "initial_connect";
    scope.device = device;
    void scope.directory.load();
    void scope.quickPrompts.refresh();
    if (!preservingWorkspace) {
      this.publishAuthenticated(
        scope,
        { phase: "synchronizing", trigger },
        null
      );
    }
    await scope.workspaceCatalog.start();
    if (this.authenticatedScope !== scope || scope.device !== device) return;
    const catalog = scope.workspaceCatalog.getSnapshot();
    if (
      catalog.status !== "ready" ||
      catalog.errorCode ||
      catalog.workspaces.length !== 1
    ) {
      if (!preservingWorkspace) this.clearConnectedDevice(scope);
      await this.closeDeviceLink();
      throw new DeviceConnectionSetupError("workspace_unavailable");
    }
    if (!(await this.selectWorkspace(catalog.workspaces[0]!, trigger))) {
      if (!preservingWorkspace) this.clearConnectedDevice(scope);
      await this.closeDeviceLink();
      throw new DeviceConnectionSetupError("workspace_unavailable");
    }
  }

  private handleAppLifecycle(state: AppLifecycleState): void {
    const foreground = state === "foreground";
    this.appForeground = foreground;
    this.ports.diagnostics.record({
      name: "application.lifecycle_changed",
      state
    });
    if (foreground) {
      const backgroundStartedAtUnixMs = this.backgroundStartedAtUnixMs;
      this.backgroundStartedAtUnixMs = null;
      const backgroundElapsedMs =
        backgroundStartedAtUnixMs === null
          ? 0
          : Math.max(0, this.ports.clock.now() - backgroundStartedAtUnixMs);
      const authenticated = this.authenticatedScope;
      authenticated?.deviceService.resumeRemoteOperations();
      if (
        this.snapshot.status === "authenticated" &&
        this.snapshot.device &&
        this.snapshot.workspace
      ) {
        if (
          backgroundElapsedMs >= BACKGROUND_GRACE_MS ||
          this.snapshot.connection.phase === "reconnecting" ||
          this.snapshot.connection.phase === "failed"
        ) {
          void this.recoverDeviceConnection("background_expired");
        } else {
          this.resumeWorkspaceConnection("foreground_resume");
        }
      }
      return;
    }
    if (this.backgroundStartedAtUnixMs !== null) return;
    this.backgroundStartedAtUnixMs = this.ports.clock.now();
    this.cancelConnectionRecovery();
    this.workspaceScope?.activity.pause();
    this.workspaceCandidate?.activity.pause();
    this.authenticatedScope?.deviceService.suspendRemoteOperations();
  }

  private resumeWorkspaceConnection(
    trigger: MobileConnectionRecoveryTrigger
  ): void {
    const authenticated = this.authenticatedScope;
    const workspace = this.workspaceScope;
    if (!authenticated?.device || !workspace) return;
    this.cancelConnectionTimers();
    this.publishAuthenticated(authenticated, {
      phase: "synchronizing",
      trigger
    });
    workspace.activity.resume();
    if (workspace.activity.isTransportConnected()) {
      this.publishAuthenticated(authenticated, { phase: "connected" });
      return;
    }
    this.scheduleConnectionReadyDeadline(workspace, trigger);
  }

  private recoverDeviceConnection(
    trigger: MobileConnectionRecoveryTrigger
  ): Promise<void> {
    if (this.deviceReconnectTask) return this.deviceReconnectTask;
    const authenticated = this.authenticatedScope;
    const current =
      this.snapshot.status === "authenticated" ? this.snapshot : null;
    const device = current?.device ?? null;
    const workspace = current?.workspace ?? null;
    if (!authenticated || !device || !workspace || !this.appForeground) {
      return Promise.resolve();
    }
    const recoveryGeneration = ++this.connectionRecoveryGeneration;
    this.cancelConnectionTimers();
    this.publishAuthenticated(
      authenticated,
      { phase: "reconnecting", trigger },
      workspace
    );
    this.workspaceScope?.activity.pause();
    authenticated.deviceService.resumeRemoteOperations();
    const task = this.closeDeviceLink()
      .then(async () => {
        if (!this.isConnectionRecoveryCurrent(recoveryGeneration, device)) {
          return;
        }
        const connected = await authenticated.deviceService.reconnect(device);
        if (
          !connected &&
          this.isConnectionRecoveryCurrent(recoveryGeneration, device)
        ) {
          this.markConnectionFailed(trigger);
        }
      })
      .finally(() => {
        if (this.deviceReconnectTask === task) {
          this.deviceReconnectTask = null;
        }
      });
    this.deviceReconnectTask = task;
    return task;
  }

  private handleWorkspaceTransportConnectionChanged(
    generation: number,
    connected: boolean
  ): void {
    if (
      this.disposed ||
      !this.appForeground ||
      generation !== this.workspaceGeneration
    ) {
      return;
    }
    const workspace = this.workspaceScope;
    if (!workspace || workspace.generation !== generation) return;
    const authenticated = this.authenticatedScope;
    if (!authenticated?.device) return;
    if (connected) {
      this.cancelConnectionTimers();
      this.publishAuthenticated(authenticated, { phase: "connected" });
      return;
    }
    const current =
      this.snapshot.status === "authenticated"
        ? this.snapshot.connection
        : null;
    if (current?.phase === "reconnecting" || current?.phase === "failed") {
      return;
    }
    this.cancelConnectionTimers();
    this.publishAuthenticated(authenticated, {
      phase: "synchronizing",
      trigger: "transport_lost"
    });
    this.scheduleConnectionReadyDeadline(workspace, "transport_lost");
    this.transportRecoveryTask = this.ports.clock.schedule(
      TRANSPORT_RECOVERY_GRACE_MS,
      () => {
        this.transportRecoveryTask = null;
        if (
          this.appForeground &&
          this.workspaceScope === workspace &&
          !workspace.activity.isTransportConnected()
        ) {
          void this.recoverDeviceConnection("transport_lost");
        }
      }
    );
  }

  private scheduleConnectionReadyDeadline(
    workspace: WorkspaceScope,
    trigger: MobileConnectionRecoveryTrigger
  ): void {
    this.connectionReadyTask?.cancel();
    this.connectionReadyTask = this.ports.clock.schedule(
      CONNECTION_READY_TIMEOUT_MS,
      () => {
        this.connectionReadyTask = null;
        if (
          this.appForeground &&
          this.workspaceScope === workspace &&
          !workspace.activity.isTransportConnected()
        ) {
          this.markConnectionFailed(trigger);
        }
      }
    );
  }

  private markConnectionFailed(trigger: MobileConnectionRecoveryTrigger): void {
    const authenticated = this.authenticatedScope;
    if (!authenticated?.device || !this.appForeground) return;
    this.cancelConnectionTimers();
    this.workspaceScope?.activity.pause();
    this.publishAuthenticated(authenticated, { phase: "failed", trigger });
  }

  private isConnectionRecoveryCurrent(
    generation: number,
    device: ConnectedDevice
  ): boolean {
    return (
      !this.disposed &&
      this.appForeground &&
      generation === this.connectionRecoveryGeneration &&
      this.authenticatedScope?.device?.pairingId === device.pairingId
    );
  }

  private cancelConnectionRecovery(): void {
    this.connectionRecoveryGeneration += 1;
    this.deviceReconnectTask = null;
    this.cancelConnectionTimers();
  }

  private cancelConnectionTimers(): void {
    this.connectionReadyTask?.cancel();
    this.connectionReadyTask = null;
    this.transportRecoveryTask?.cancel();
    this.transportRecoveryTask = null;
  }

  private disposeWorkspaceScope(): void {
    this.workspaceGeneration += 1;
    const candidate = this.workspaceCandidate;
    this.workspaceCandidate = null;
    if (candidate) {
      candidate.container.dispose();
    }
    const scope = this.workspaceScope;
    this.workspaceScope = null;
    if (!scope) return;
    scope.container.dispose();
  }

  private disposeAuthenticatedScope(): void {
    this.cancelConnectionRecovery();
    this.disposeWorkspaceScope();
    const scope = this.authenticatedScope;
    this.authenticatedScope = null;
    if (!scope) return;
    scope.container.dispose();
  }

  private disposeLoginScope(): void {
    const scope = this.loginScope;
    this.loginScope = null;
    if (!scope) return;
    scope.container.dispose();
  }

  private publish(snapshot: MobileApplicationSnapshot): void {
    this.snapshot = snapshot;
    this.emitChange();
  }

  private publishAuthenticated(
    scope: AuthenticatedScope,
    connection: MobileConnectionSnapshot,
    workspace: WorkspaceSummary | null = this.workspaceScope?.workspace ?? null
  ): void {
    if (this.authenticatedScope !== scope) return;
    const previousConnection =
      this.snapshot.status === "authenticated"
        ? this.snapshot.connection
        : null;
    const previousTrigger =
      previousConnection && "trigger" in previousConnection
        ? previousConnection.trigger
        : null;
    const nextTrigger = "trigger" in connection ? connection.trigger : null;
    if (
      previousConnection?.phase !== connection.phase ||
      previousTrigger !== nextTrigger
    ) {
      this.ports.diagnostics.record({
        name: "device_connection.phase_changed",
        phase: connection.phase,
        ...(nextTrigger ? { trigger: nextTrigger } : {})
      });
    }
    this.publish({
      connection,
      device: scope.device,
      session: scope.session,
      status: "authenticated",
      workspace
    });
  }

  private clearConnectedDevice(scope: AuthenticatedScope): void {
    if (this.authenticatedScope !== scope) return;
    this.cancelConnectionRecovery();
    this.disposeWorkspaceScope();
    scope.device = null;
    scope.quickPrompts.reset();
    this.publishAuthenticated(scope, { phase: "idle" }, null);
  }

  private closeDeviceLink(): Promise<void> {
    if (this.deviceLinkCloseTask) return this.deviceLinkCloseTask;
    const task = Promise.resolve()
      .then(() => this.ports.deviceLink.closeLink())
      .catch(() => undefined)
      .finally(() => {
        if (this.deviceLinkCloseTask === task) {
          this.deviceLinkCloseTask = null;
        }
      });
    this.deviceLinkCloseTask = task;
    return task;
  }
}
