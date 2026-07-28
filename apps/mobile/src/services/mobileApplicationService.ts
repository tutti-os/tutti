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

export type MobileApplicationSnapshot =
  | { status: "bootstrapping" }
  | { status: "unauthenticated" }
  | {
      status: "authenticated";
      device: ConnectedDevice | null;
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
  private backgroundTask: { cancel(): void } | null = null;
  private deviceDisconnectTask: Promise<void> | null = null;
  private deviceLinkCloseTask: Promise<void> | null = null;
  private appForeground = true;
  private startPromise: Promise<void> | null = null;
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

  private async selectWorkspace(workspace: WorkspaceSummary): Promise<boolean> {
    const authenticated = this.authenticatedScope;
    if (!authenticated?.device) return false;
    this.disposeWorkspaceScope();
    const generation = ++this.workspaceGeneration;
    const navigation = new WorkspaceNavigationService();
    const drafts = new ComposerDraftService();
    const activity = new WorkspaceActivityService(
      workspace,
      authenticated.client,
      authenticated.directory,
      navigation,
      drafts,
      this.ports.clock,
      authenticated.session.userId,
      this.ports.deviceLink
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
      this.workspaceScope = candidate;
      this.publish({
        device: authenticated.device,
        session: authenticated.session,
        status: "authenticated",
        workspace
      });
      return true;
    } catch {
      if (this.workspaceCandidate === candidate) {
        this.workspaceCandidate = null;
        candidate.container.dispose();
      }
      if (
        generation === this.workspaceGeneration &&
        this.authenticatedScope === authenticated &&
        authenticated.device
      ) {
        this.publish({
          device: authenticated.device,
          session: authenticated.session,
          status: "authenticated",
          workspace: null
        });
      }
      return false;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.backgroundTask?.cancel();
    this.backgroundTask = null;
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
    scope.device = device;
    void scope.directory.load();
    void scope.quickPrompts.refresh();
    this.publish({
      device,
      session: scope.session,
      status: "authenticated",
      workspace: null
    });
    await scope.workspaceCatalog.start();
    if (this.authenticatedScope !== scope || scope.device !== device) return;
    const catalog = scope.workspaceCatalog.getSnapshot();
    if (
      catalog.status !== "ready" ||
      catalog.errorCode ||
      catalog.workspaces.length !== 1
    ) {
      this.clearConnectedDevice(scope);
      await this.closeDeviceLink();
      throw new DeviceConnectionSetupError("workspace_unavailable");
    }
    if (!(await this.selectWorkspace(catalog.workspaces[0]!))) {
      this.clearConnectedDevice(scope);
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
      const hadPendingGrace = this.backgroundTask !== null;
      this.backgroundTask?.cancel();
      this.backgroundTask = null;
      if (hadPendingGrace) {
        this.workspaceScope?.activity.resume();
        this.workspaceCandidate?.activity.resume();
      }
      if (
        this.snapshot.status === "authenticated" &&
        this.snapshot.device === null &&
        this.deviceDisconnectTask === null
      ) {
        this.authenticatedScope?.deviceService.resumeRemoteOperations();
      }
      return;
    }
    if (this.backgroundTask) return;
    this.workspaceScope?.activity.pause();
    this.workspaceCandidate?.activity.pause();
    this.authenticatedScope?.deviceService.suspendRemoteOperations();
    this.backgroundTask = this.ports.clock.schedule(BACKGROUND_GRACE_MS, () => {
      this.backgroundTask = null;
      void this.disconnectDevice();
    });
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

  private clearConnectedDevice(scope: AuthenticatedScope): void {
    if (this.authenticatedScope !== scope) return;
    this.disposeWorkspaceScope();
    scope.device = null;
    scope.quickPrompts.reset();
    this.publish({
      device: null,
      session: scope.session,
      status: "authenticated",
      workspace: null
    });
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
