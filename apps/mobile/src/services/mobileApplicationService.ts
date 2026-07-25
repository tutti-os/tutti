import type {
  TuttidClient,
  WorkspaceSummary
} from "@tutti-os/client-tuttid-ts";
import {
  ServiceCollection,
  type IInstantiationService
} from "@tutti-os/infra/di";
import { accountBaseURL } from "../config";
import type { AccountSession } from "./mobileDomain";
import { AgentDirectoryService } from "./agentDirectoryService";
import { ComposerDraftService } from "./composerDraftService";
import { DeviceService, type ConnectedDevice } from "./deviceService";
import { LoginService } from "./loginService";
import {
  IAgentDirectoryService,
  IComposerDraftService,
  IDeviceService,
  ILoginService,
  IWorkspaceActivityService,
  IWorkspaceCatalogService,
  IWorkspaceNavigationService
} from "./mobileServiceIdentifiers";
import { ObservableService } from "./observableService";
import type { MobileServicePorts } from "./servicePorts";
import { WorkspaceActivityService } from "./workspaceActivityService";
import { WorkspaceCatalogService } from "./workspaceCatalogService";
import { WorkspaceNavigationService } from "./workspaceNavigationService";

const BACKGROUND_GRACE_MS = 15_000;

export type MobileApplicationSnapshot =
  | { route: "bootstrapping" }
  | { route: "login" }
  | { route: "devices"; session: AccountSession }
  | {
      route: "workspaces";
      device: ConnectedDevice;
      session: AccountSession;
    }
  | {
      route: "workspace";
      device: ConnectedDevice;
      session: AccountSession;
      workspace: WorkspaceSummary;
    };

interface AuthenticatedScope {
  client: TuttidClient;
  container: IInstantiationService;
  device: ConnectedDevice | null;
  deviceService: DeviceService;
  directory: AgentDirectoryService;
  session: AccountSession;
  workspaceCatalog: WorkspaceCatalogService;
}

interface WorkspaceScope {
  activity: WorkspaceActivityService;
  container: IInstantiationService;
  drafts: ComposerDraftService;
  navigation: WorkspaceNavigationService;
  workspace: WorkspaceSummary;
}

export class MobileApplicationService extends ObservableService<MobileApplicationSnapshot> {
  readonly _serviceBrand: undefined;
  private snapshot: MobileApplicationSnapshot = { route: "bootstrapping" };
  private loginScope: {
    container: IInstantiationService;
    service: LoginService;
  } | null = null;
  private authenticatedScope: AuthenticatedScope | null = null;
  private workspaceScope: WorkspaceScope | null = null;
  private workspaceCandidate: WorkspaceScope | null = null;
  private lifecycleDispose: (() => void) | null = null;
  private backgroundTask: { cancel(): void } | null = null;
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

  get workspaceCatalogService(): WorkspaceCatalogService | null {
    return this.authenticatedScope?.workspaceCatalog ?? null;
  }

  get workspaceActivityService(): WorkspaceActivityService | null {
    return this.workspaceScope?.activity ?? null;
  }

  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.lifecycleDispose = this.ports.lifecycle.subscribe((active) =>
      this.handleLifecycle(active)
    );
    this.startPromise = this.ports.sessionStorage
      .loadSession()
      .then(async (session) => {
        if (this.disposed) return;
        if (session) {
          await this.ports.sessionStorage.installSessionCookie(
            accountBaseURL,
            session.sessionId
          );
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
    await this.ports.deviceLink.closeLink().catch(() => undefined);
    await this.ports.sessionStorage.clearSession();
    await this.ports.sessionStorage
      .clearSessionCookie(accountBaseURL)
      .catch(() => undefined);
    this.disposeAuthenticatedScope();
    this.enterUnauthenticated();
  }

  async disconnectDevice(): Promise<void> {
    await this.ports.deviceLink.closeLink().catch(() => undefined);
    this.disposeWorkspaceScope();
    const scope = this.authenticatedScope;
    if (!scope) return;
    scope.device = null;
    this.publish({ route: "devices", session: scope.session });
    scope.deviceService.resume();
  }

  showWorkspacePicker(): void {
    const scope = this.authenticatedScope;
    if (!scope?.device) return;
    this.disposeWorkspaceScope();
    this.publish({
      device: scope.device,
      route: "workspaces",
      session: scope.session
    });
  }

  async selectWorkspace(workspace: WorkspaceSummary): Promise<void> {
    const authenticated = this.authenticatedScope;
    if (!authenticated?.device) return;
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
      authenticated.session.userId
    );
    const services = new ServiceCollection();
    services.set(IWorkspaceNavigationService, navigation);
    services.set(IComposerDraftService, drafts);
    services.set(IWorkspaceActivityService, activity);
    const container = authenticated.container.createChild(services);
    const candidate: WorkspaceScope = {
      activity,
      container,
      drafts,
      navigation,
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
        return;
      }
      this.workspaceCandidate = null;
      this.workspaceScope = candidate;
      this.publish({
        device: authenticated.device,
        route: "workspace",
        session: authenticated.session,
        workspace
      });
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
          route: "workspaces",
          session: authenticated.session
        });
      }
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
    this.publish({ route: "login" });
  }

  private enterAuthenticated(session: AccountSession): void {
    this.disposeAuthenticatedScope();
    const client = this.ports.createRemoteClient();
    const directory = new AgentDirectoryService(client);
    const workspaceCatalog = new WorkspaceCatalogService(client);
    const deviceService = new DeviceService(
      session,
      this.ports.pairing,
      this.ports.deviceSecurity,
      this.ports.clock,
      (device) => this.onDeviceConnected(device)
    );
    const services = new ServiceCollection();
    services.set(IDeviceService, deviceService);
    services.set(IAgentDirectoryService, directory);
    services.set(IWorkspaceCatalogService, workspaceCatalog);
    const container = this.rootContainer.createChild(services);
    this.authenticatedScope = {
      client,
      container,
      device: null,
      deviceService,
      directory,
      session,
      workspaceCatalog
    };
    this.publish({ route: "devices", session });
    deviceService.start();
  }

  private async onDeviceConnected(device: ConnectedDevice): Promise<void> {
    const scope = this.authenticatedScope;
    if (!scope) return;
    scope.device = device;
    scope.deviceService.pause();
    void scope.directory.load();
    this.publish({
      device,
      route: "workspaces",
      session: scope.session
    });
    await scope.workspaceCatalog.start();
    if (this.authenticatedScope !== scope || scope.device !== device) return;
    const workspaces = scope.workspaceCatalog.getSnapshot().workspaces;
    if (workspaces.length === 1) {
      await this.selectWorkspace(workspaces[0]!);
    }
  }

  private handleLifecycle(active: boolean): void {
    if (active) {
      const hadPendingGrace = this.backgroundTask !== null;
      this.backgroundTask?.cancel();
      this.backgroundTask = null;
      if (hadPendingGrace) {
        this.workspaceScope?.activity.resume();
        this.workspaceCandidate?.activity.resume();
        if (this.snapshot.route === "devices") {
          this.authenticatedScope?.deviceService.resume();
        }
      }
      return;
    }
    if (this.backgroundTask) return;
    this.workspaceScope?.activity.pause();
    this.workspaceCandidate?.activity.pause();
    this.authenticatedScope?.deviceService.pause();
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
}
