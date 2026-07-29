import assert from "node:assert/strict";
import test from "node:test";
import type { TuttidClient } from "@tutti-os/client-tuttid-ts";
import type { NotificationService } from "@tutti-os/ui-notifications";
import type { DesktopHostFilesApi, DesktopPlatformApi } from "@preload/types";
import { DesktopWorkspaceUserProjectService } from "./desktopWorkspaceUserProjectService.ts";

type TuttidUserProject = Awaited<ReturnType<TuttidClient["useUserProject"]>>;

test("workspace user project service loads projects into Valtio state once", async () => {
  let listCalls = 0;
  const service = createService({
    tuttidClient: createTuttidClient({
      async listUserProjects() {
        listCalls += 1;
        return {
          projects: [
            createProject({
              id: "project-1",
              path: "/workspace/tutti"
            })
          ]
        };
      }
    })
  });

  await service.ensureLoaded();
  await service.ensureLoaded();

  assert.equal(listCalls, 1);
  assert.equal(service.store.initialized, true);
  assert.equal(service.store.isLoading, false);
  assert.equal(service.store.error, null);
  assert.deepEqual(service.store.projects, [
    createProject({
      id: "project-1",
      path: "/workspace/tutti"
    })
  ]);
  assert.equal(service.getSnapshot().projects.length, 1);
  assert.equal(service.getRevision() > 0, true);
});

test("workspace user project service refresh updates projects and preserves them on API failure", async () => {
  const service = createService({
    tuttidClient: createTuttidClient({
      async listUserProjects() {
        return {
          projects: [
            createProject({
              id: "project-1",
              path: "/workspace/tutti"
            })
          ]
        };
      }
    })
  });

  await service.refresh();
  assert.equal(service.store.error, null);
  assert.deepEqual(
    service.store.projects.map((project) => project.path),
    ["/workspace/tutti"]
  );

  const failingService = createService({
    tuttidClient: createTuttidClient({
      async listUserProjects() {
        throw new Error("tuttid offline");
      }
    })
  });
  failingService.store.projects = [
    createProject({
      id: "project-existing",
      path: "/workspace/existing"
    })
  ];

  await failingService.refresh();

  assert.equal(failingService.store.error, "tuttid offline");
  assert.deepEqual(
    failingService.store.projects.map((project) => project.path),
    ["/workspace/existing"]
  );
});

test("workspace user project service registers project paths and remembers default selection", async () => {
  const usedPaths: string[] = [];
  const registeredProject = createProject({
    id: "project-registered",
    label: "Registered",
    path: "/workspace/registered"
  });
  const service = createService({
    tuttidClient: createTuttidClient({
      async listUserProjects() {
        return { projects: [registeredProject] };
      },
      async useUserProject(input) {
        usedPaths.push(input.path);
        return registeredProject;
      }
    })
  });

  const beforeRevision = service.getRevision();
  const project = await service.registerProjectPath("/workspace/registered");

  assert.deepEqual(project, registeredProject);
  assert.deepEqual(usedPaths, ["/workspace/registered"]);
  assert.equal(service.store.initialized, true);
  assert.equal(service.getRevision() > beforeRevision, true);
  assert.deepEqual(service.store.projects, [registeredProject]);
  assert.deepEqual(await service.getDefaultSelection(), {
    path: "/workspace/registered"
  });
});

test("workspace user project service removes project paths until they are registered again", async () => {
  const deletedPaths: string[] = [];
  const projects = [
    createProject({ id: "project-alpha", path: "/workspace/alpha" }),
    createProject({ id: "project-beta", path: "/workspace/beta" })
  ];
  const service = createService({
    tuttidClient: createTuttidClient({
      async deleteUserProject(input) {
        deletedPaths.push(input.path);
      },
      async listUserProjects() {
        return { projects };
      },
      async useUserProject(input) {
        return (
          projects.find((project) => project.path === input.path) ??
          createProject({ path: input.path })
        );
      }
    })
  });

  await service.refresh();
  await service.rememberDefaultSelection({ path: "/workspace/beta" });

  const beforeRevision = service.getRevision();
  await service.removeProjectPath("/workspace/beta");

  assert.equal(service.getRevision() > beforeRevision, true);
  assert.deepEqual(deletedPaths, ["/workspace/beta"]);
  assert.deepEqual(
    service.store.projects.map((project) => project.path),
    ["/workspace/alpha"]
  );
  assert.deepEqual(await service.getDefaultSelection(), { path: null });

  await service.refresh();
  assert.deepEqual(
    service.store.projects.map((project) => project.path),
    ["/workspace/alpha"]
  );

  await service.registerProjectPath("/workspace/beta");
  assert.deepEqual(
    service.store.projects.map((project) => project.path),
    ["/workspace/alpha", "/workspace/beta"]
  );
  assert.deepEqual(await service.getDefaultSelection(), {
    path: "/workspace/beta"
  });
});

test("workspace user project service keeps registered project when stale refresh resolves later", async () => {
  const staleList = createDeferred<{ projects: TuttidUserProject[] }>();
  let listCalls = 0;
  const registeredProject = createProject({
    id: "project-registered",
    label: "Registered",
    path: "/workspace/registered"
  });
  const service = createService({
    tuttidClient: createTuttidClient({
      async listUserProjects() {
        listCalls += 1;
        if (listCalls === 1) {
          return staleList.promise;
        }
        return { projects: [registeredProject] };
      },
      async useUserProject() {
        return registeredProject;
      }
    })
  });

  const initialRefresh = service.refresh();
  await Promise.resolve();

  await service.registerProjectPath("/workspace/registered");
  assert.deepEqual(service.store.projects, [registeredProject]);

  staleList.resolve({
    projects: [
      createProject({
        id: "project-stale",
        path: "/workspace/stale"
      })
    ]
  });
  await initialRefresh;

  assert.deepEqual(service.store.projects, [registeredProject]);
});

test("workspace user project service remembers generated no-project cwd values", () => {
  const service = createService();

  service.rememberNoProjectPath("/tmp/custom-no-project");

  assert.equal(service.isNoProjectPath("/tmp/custom-no-project"), true);
  assert.equal(service.isNoProjectPath("/tmp/other"), false);
});

test("workspace user project service lets an explicit project override generated no-project paths", async () => {
  const generatedLikePath =
    "/Users/local/Documents/tutti/session-44444444-4444-4444-8444-444444444444";
  const service = createService({
    tuttidClient: createTuttidClient({
      async useUserProject(input) {
        return createProject({
          id: "odd-project",
          label: "Odd project",
          path: input.path
        });
      }
    })
  });

  service.rememberNoProjectPath(generatedLikePath);
  assert.equal(service.isNoProjectPath(generatedLikePath), true);

  await service.registerProjectPath(generatedLikePath);

  assert.equal(service.isNoProjectPath(generatedLikePath), false);
});

test("workspace user project service creates a documents directory before registering project", async () => {
  const calls: Array<{ method: string; path?: string; name?: string }> = [];
  const service = createService({
    hostFilesApi: createHostFilesApi({
      async createUserDocumentsProjectDirectory(input) {
        calls.push({ method: "createDirectory", name: input.name });
        return { path: `/Users/local/Documents/tutti/${input.name}` };
      }
    }),
    tuttidClient: createTuttidClient({
      async listUserProjects() {
        return { projects: [] };
      },
      async useUserProject(input) {
        calls.push({ method: "useProject", path: input.path });
        return createProject({
          label: "Demo project",
          path: input.path
        });
      }
    })
  });

  const project = await service.createProject("Demo project");

  assert.equal(project.path, "/Users/local/Documents/tutti/Demo project");
  assert.deepEqual(calls, [
    { method: "createDirectory", name: "Demo project" },
    {
      method: "useProject",
      path: "/Users/local/Documents/tutti/Demo project"
    }
  ]);
  assert.deepEqual(await service.getDefaultSelection(), {
    path: "/Users/local/Documents/tutti/Demo project"
  });
});

test("workspace user project service delegates path checks, directory selection, and no-project cwd detection", async () => {
  const service = createService({
    hostFilesApi: createHostFilesApi({
      async selectDirectory() {
        return "/workspace";
      }
    }),
    tuttidClient: createTuttidClient({
      async checkUserProjectPath(input) {
        return {
          exists: true,
          isDirectory: true,
          path: input.path
        };
      }
    })
  });

  assert.deepEqual(await service.checkProjectPath("/workspace"), {
    exists: true,
    isDirectory: true,
    path: "/workspace"
  });
  assert.deepEqual(await service.selectDirectory(), { path: "/workspace" });
  assert.equal(
    service.isNoProjectPath(
      "/Users/local/Documents/tutti/session-44444444-4444-4444-8444-444444444444"
    ),
    true
  );
  assert.equal(service.isNoProjectPath("/workspace"), false);
});

test("workspace user project service prepares selection decisions", async () => {
  const projects = [
    createProject({ id: "project-alpha", path: "/workspace/alpha" }),
    createProject({ id: "project-beta", path: "/workspace/beta" })
  ];
  const service = createService({
    tuttidClient: createTuttidClient({
      async checkUserProjectPath(input) {
        return {
          exists: input.path !== "/workspace/missing",
          isDirectory: input.path !== "/workspace/missing",
          path: input.path
        };
      },
      async listUserProjects() {
        return { projects };
      }
    })
  });

  assert.deepEqual(
    await service.prepareSelection({
      projectLocked: false,
      selectedPath: null
    }),
    {
      isSelectedPathMissing: false,
      projects,
      selection: { kind: "none" }
    }
  );

  await service.rememberDefaultSelection({ path: "/workspace/beta" });

  assert.deepEqual(
    await service.prepareSelection({
      projectLocked: false,
      selectedPath: null
    }),
    {
      isSelectedPathMissing: false,
      projects,
      selection: {
        kind: "select",
        path: "/workspace/beta"
      }
    }
  );

  assert.deepEqual(
    await service.prepareSelection({
      projectLocked: false,
      selectedPath: "/workspace/stale"
    }),
    {
      isSelectedPathMissing: false,
      projects,
      selection: {
        kind: "clear",
        suppressedPath: "/workspace/stale"
      }
    }
  );
  assert.deepEqual(await service.getDefaultSelection(), { path: null });

  assert.deepEqual(
    await service.prepareSelection({
      projectLocked: true,
      selectedPath: "/workspace/missing"
    }),
    {
      isSelectedPathMissing: true,
      projects,
      selection: { kind: "none" }
    }
  );

  await service.rememberDefaultSelection({ path: null });
  assert.deepEqual(
    await service.prepareSelection({
      projectLocked: false,
      selectedPath: null
    }),
    {
      isSelectedPathMissing: false,
      projects,
      selection: { kind: "none" }
    }
  );
});

test("workspace user project service reports directory selection failures through notifications", async () => {
  const notifications: Array<{ title: string }> = [];
  const service = createService({
    hostFilesApi: createHostFilesApi({
      async selectDirectory() {
        throw new Error("dialog failed");
      }
    }),
    notifications: createNotificationService(notifications)
  });

  assert.equal(await service.selectDirectory(), null);
  assert.deepEqual(notifications, [
    { title: "Unable to select project directory" }
  ]);
});

test("workspace user project service moves optimistically and confirms from the response snapshot", async () => {
  const response = createDeferred<{ projects: TuttidUserProject[] }>();
  let moveCalls = 0;
  const alpha = createProject({ id: "alpha", path: "/workspace/alpha" });
  const beta = createProject({ id: "beta", path: "/workspace/beta" });
  const service = createService({
    tuttidClient: createTuttidClient({
      async listUserProjects() {
        return { projects: [alpha, beta] };
      },
      async moveUserProject() {
        moveCalls += 1;
        return response.promise;
      }
    })
  });
  await service.ensureLoaded();

  const moving = service.moveProject({
    beforeProjectId: "alpha",
    projectId: "beta"
  });
  assert.deepEqual(
    service.store.projects.map((project) => project.id),
    ["beta", "alpha"]
  );
  assert.equal(service.store.isMutationPending, true);
  assert.equal(service.store.isLoading, false);
  await assert.rejects(
    service.moveProject({ beforeProjectId: null, projectId: "alpha" }),
    /mutation is already in progress/
  );
  assert.equal(moveCalls, 1);

  response.resolve({ projects: [beta, alpha] });
  await moving;
  assert.equal(service.store.isMutationPending, false);
  assert.deepEqual(
    service.store.projects.map((project) => project.id),
    ["beta", "alpha"]
  );
});

test("workspace user project service keeps optimistic order after a move failure", async () => {
  const diagnostics: unknown[] = [];
  let listCalls = 0;
  const alpha = createProject({ id: "alpha", path: "/workspace/alpha" });
  const beta = createProject({ id: "beta", path: "/workspace/beta" });
  const service = createService({
    logDiagnostic: (payload) => diagnostics.push(payload),
    tuttidClient: createTuttidClient({
      async listUserProjects() {
        listCalls += 1;
        return { projects: [alpha, beta] };
      },
      async moveUserProject() {
        throw new Error("move unavailable");
      }
    })
  });
  await service.ensureLoaded();

  await assert.rejects(
    service.moveProject({ beforeProjectId: "alpha", projectId: "beta" }),
    /move unavailable/
  );
  assert.deepEqual(
    service.store.projects.map((project) => project.id),
    ["beta", "alpha"]
  );
  assert.equal(service.store.error, null);
  assert.equal(listCalls, 1);
  assert.equal(diagnostics.length, 1);
});

test("workspace user project service pins optimistically and confirms from the response snapshot", async () => {
  const response = createDeferred<{ projects: TuttidUserProject[] }>();
  const pinned = createProject({
    id: "pinned",
    path: "/workspace/pinned",
    pinnedAtUnixMs: 10,
    updatedAtUnixMs: 10
  });
  const ordinary = createProject({
    id: "ordinary",
    lastUsedAtUnixMs: 7,
    path: "/workspace/ordinary"
  });
  const authoritativeOrdinary = {
    ...ordinary,
    pinnedAtUnixMs: 30,
    updatedAtUnixMs: 30
  };
  const service = createService({
    now: () => 20,
    tuttidClient: createTuttidClient({
      async listUserProjects() {
        return { projects: [pinned, ordinary] };
      },
      async pinUserProject(input) {
        assert.deepEqual(input, { pinned: true, projectId: "ordinary" });
        return response.promise;
      }
    })
  });
  await service.ensureLoaded();

  const pinning = service.pinProject({
    pinned: true,
    projectId: "ordinary"
  });
  assert.equal(service.store.isMutationPending, true);
  assert.deepEqual(
    service.store.projects.map((project) => project.id),
    ["ordinary", "pinned"]
  );
  assert.equal(service.store.projects[0]?.pinnedAtUnixMs, 20);
  assert.equal(service.store.projects[0]?.updatedAtUnixMs, 20);
  assert.equal(service.store.projects[0]?.lastUsedAtUnixMs, 7);
  await assert.rejects(
    service.removeProjectPath("/workspace/pinned"),
    /mutation is already in progress/
  );

  response.resolve({ projects: [authoritativeOrdinary, pinned] });
  await pinning;
  assert.equal(service.store.isMutationPending, false);
  assert.deepEqual(service.store.projects, [authoritativeOrdinary, pinned]);
});

test("workspace user project service keeps optimistic unpin state after failure", async () => {
  const diagnostics: unknown[] = [];
  const workspaceId = "workspace-pin-failure";
  const first = createProject({
    id: "first",
    path: "/workspace/first",
    pinnedAtUnixMs: 20
  });
  const second = createProject({
    id: "second",
    lastUsedAtUnixMs: 9,
    path: "/workspace/second",
    pinnedAtUnixMs: 10
  });
  const ordinary = createProject({
    id: "ordinary",
    path: "/workspace/ordinary"
  });
  const service = createService({
    logDiagnostic: (payload) => diagnostics.push(payload),
    now: () => 40,
    workspaceId,
    tuttidClient: createTuttidClient({
      async listUserProjects() {
        return { projects: [first, second, ordinary] };
      },
      async pinUserProject() {
        throw new Error("pin unavailable");
      }
    })
  });
  await service.ensureLoaded();

  await assert.rejects(
    service.pinProject({ pinned: false, projectId: "second" }),
    /pin unavailable/
  );
  assert.deepEqual(
    service.store.projects.map((project) => project.id),
    ["first", "second", "ordinary"]
  );
  assert.equal(service.store.projects[1]?.pinnedAtUnixMs, 0);
  assert.equal(service.store.projects[1]?.updatedAtUnixMs, 40);
  assert.equal(service.store.projects[1]?.lastUsedAtUnixMs, 9);
  assert.equal(service.store.error, null);
  assert.deepEqual(diagnostics, [
    {
      error: "pin unavailable",
      event: "user_project_pin_failed",
      workspaceId
    }
  ]);
});

test("workspace user project service reconciles a conflicting event after pin success", async () => {
  const events = createUserProjectEventStream();
  const response = createDeferred<{ projects: TuttidUserProject[] }>();
  const alpha = createProject({ id: "alpha", path: "/workspace/alpha" });
  const beta = createProject({ id: "beta", path: "/workspace/beta" });
  const pinnedBeta = { ...beta, pinnedAtUnixMs: 20, updatedAtUnixMs: 20 };
  const gamma = createProject({ id: "gamma", path: "/workspace/gamma" });
  let listCalls = 0;
  const service = createService({
    eventStreamClient: events.client,
    tuttidClient: createTuttidClient({
      async listUserProjects() {
        listCalls += 1;
        return {
          projects: listCalls === 1 ? [alpha, beta] : [pinnedBeta, gamma, alpha]
        };
      },
      async pinUserProject() {
        return response.promise;
      }
    })
  });
  await service.ensureLoaded();

  const pinning = service.pinProject({ pinned: true, projectId: "beta" });
  events.emit([pinnedBeta, gamma, alpha]);
  response.resolve({ projects: [pinnedBeta, alpha] });
  await pinning;

  assert.equal(listCalls, 2);
  assert.deepEqual(
    service.store.projects.map((project) => project.id),
    ["beta", "gamma", "alpha"]
  );
});

test("workspace user project service applies global events and reconciles a differing event after move success", async () => {
  const events = createUserProjectEventStream();
  const response = createDeferred<{ projects: TuttidUserProject[] }>();
  const alpha = createProject({ id: "alpha", path: "/workspace/alpha" });
  const beta = createProject({ id: "beta", path: "/workspace/beta" });
  const gamma = createProject({ id: "gamma", path: "/workspace/gamma" });
  let listCalls = 0;
  const service = createService({
    eventStreamClient: events.client,
    tuttidClient: createTuttidClient({
      async listUserProjects() {
        listCalls += 1;
        return {
          projects: listCalls === 1 ? [alpha, beta] : [gamma, beta, alpha]
        };
      },
      async moveUserProject() {
        return response.promise;
      }
    })
  });
  await service.ensureLoaded();
  events.emit([beta, alpha]);
  assert.deepEqual(
    service.store.projects.map((project) => project.id),
    ["beta", "alpha"]
  );

  const moving = service.moveProject({
    beforeProjectId: "beta",
    projectId: "alpha"
  });
  events.emit([gamma, alpha, beta]);
  response.resolve({ projects: [alpha, beta] });
  await moving;
  assert.equal(listCalls, 2);
  assert.deepEqual(
    service.store.projects.map((project) => project.id),
    ["gamma", "beta", "alpha"]
  );
});

test("workspace user project service keeps an event received during move reconciliation refresh", async () => {
  const events = createUserProjectEventStream();
  const moveResponse = createDeferred<{ projects: TuttidUserProject[] }>();
  const refreshResponse = createDeferred<{ projects: TuttidUserProject[] }>();
  const alpha = createProject({ id: "alpha", path: "/workspace/alpha" });
  const beta = createProject({ id: "beta", path: "/workspace/beta" });
  const gamma = createProject({ id: "gamma", path: "/workspace/gamma" });
  const delta = createProject({ id: "delta", path: "/workspace/delta" });
  let listCalls = 0;
  const service = createService({
    eventStreamClient: events.client,
    tuttidClient: createTuttidClient({
      async listUserProjects() {
        listCalls += 1;
        return listCalls === 1
          ? { projects: [alpha, beta] }
          : refreshResponse.promise;
      },
      async moveUserProject() {
        return moveResponse.promise;
      }
    })
  });
  await service.ensureLoaded();

  const moving = service.moveProject({
    beforeProjectId: "alpha",
    projectId: "beta"
  });
  events.emit([gamma, beta, alpha]);
  moveResponse.resolve({ projects: [beta, alpha] });
  while (listCalls < 2) await Promise.resolve();
  events.emit([delta, gamma, beta, alpha]);
  refreshResponse.resolve({ projects: [gamma, beta, alpha] });
  await moving;

  assert.equal(listCalls, 2);
  assert.deepEqual(
    service.store.projects.map((project) => project.id),
    ["delta", "gamma", "beta", "alpha"]
  );
});

test("workspace user project authoritative events and moves supersede stale loading", async () => {
  const events = createUserProjectEventStream();
  const staleList = createDeferred<{ projects: TuttidUserProject[] }>();
  const moveResponse = createDeferred<{ projects: TuttidUserProject[] }>();
  const alpha = createProject({ id: "alpha", path: "/workspace/alpha" });
  const beta = createProject({ id: "beta", path: "/workspace/beta" });
  const service = createService({
    eventStreamClient: events.client,
    tuttidClient: createTuttidClient({
      async listUserProjects() {
        return staleList.promise;
      },
      async moveUserProject() {
        return moveResponse.promise;
      }
    })
  });

  const loading = service.refresh();
  await Promise.resolve();
  assert.equal(service.store.isLoading, true);
  events.emit([alpha, beta]);
  assert.equal(service.store.isLoading, false);

  const moving = service.moveProject({
    beforeProjectId: "alpha",
    projectId: "beta"
  });
  assert.equal(service.store.isLoading, false);
  staleList.resolve({ projects: [alpha] });
  await loading;
  assert.deepEqual(
    service.store.projects.map((project) => project.id),
    ["beta", "alpha"]
  );
  moveResponse.resolve({ projects: [beta, alpha] });
  await moving;
});

test("workspace user project service exposes deletion as a shared mutation lock", async () => {
  const deletion = createDeferred<void>();
  const service = createService({
    tuttidClient: createTuttidClient({
      async deleteUserProject() {
        return deletion.promise;
      }
    })
  });
  service.store.projects = [
    createProject({ id: "alpha", path: "/workspace/alpha" })
  ];

  const removing = service.removeProjectPath("/workspace/alpha");
  assert.equal(service.store.isMutationPending, true);
  await assert.rejects(
    service.moveProject({ beforeProjectId: null, projectId: "alpha" }),
    /mutation is already in progress/
  );
  await assert.rejects(
    service.pinProject({ pinned: true, projectId: "alpha" }),
    /mutation is already in progress/
  );
  await assert.rejects(
    service.registerProjectPath("/workspace/beta"),
    /mutation is already in progress/
  );
  await assert.rejects(
    service.createProject("beta"),
    /mutation is already in progress/
  );
  deletion.resolve();
  await removing;
  assert.equal(service.store.isMutationPending, false);
});

test("workspace user project service exposes create and register as shared mutations", async () => {
  const registration = createDeferred<TuttidUserProject>();
  const directoryCreation = createDeferred<{ path: string }>();
  const service = createService({
    hostFilesApi: createHostFilesApi({
      async createUserDocumentsProjectDirectory() {
        return directoryCreation.promise;
      }
    }),
    tuttidClient: createTuttidClient({
      async useUserProject() {
        return registration.promise;
      }
    })
  });

  const registering = service.registerProjectPath("/workspace/registered");
  assert.equal(service.store.isMutationPending, true);
  await assert.rejects(
    service.createProject("created"),
    /mutation is already in progress/
  );
  registration.resolve(
    createProject({ id: "registered", path: "/workspace/registered" })
  );
  await registering;
  assert.equal(service.store.isMutationPending, false);

  const creating = service.createProject("created");
  assert.equal(service.store.isMutationPending, true);
  await assert.rejects(
    service.registerProjectPath("/workspace/other"),
    /mutation is already in progress/
  );
  directoryCreation.resolve({ path: "/workspace/created" });
  await creating;
  assert.equal(service.store.isMutationPending, false);
});

function createService(
  overrides: {
    hostFilesApi?: DesktopWorkspaceUserProjectServiceTestHostFilesApi;
    tuttidClient?: DesktopWorkspaceUserProjectServiceTestTuttidClient;
    notifications?: NotificationService;
    platformApi?: DesktopWorkspaceUserProjectServiceTestPlatformApi;
    now?: () => number;
    workspaceId?: string;
    eventStreamClient?: ConstructorParameters<
      typeof DesktopWorkspaceUserProjectService
    >[0]["eventStreamClient"];
    logDiagnostic?: (payload: unknown) => void;
  } = {}
): DesktopWorkspaceUserProjectService {
  return new DesktopWorkspaceUserProjectService({
    hostFilesApi: overrides.hostFilesApi ?? createHostFilesApi(),
    tuttidClient: overrides.tuttidClient ?? createTuttidClient(),
    notifications: overrides.notifications,
    eventStreamClient: overrides.eventStreamClient,
    logDiagnostic: overrides.logDiagnostic,
    now: overrides.now,
    platformApi: overrides.platformApi ?? createPlatformApi(),
    workspaceId:
      overrides.workspaceId ??
      `workspace-user-project-service-test-${Math.random()}`
  });
}

function createUserProjectEventStream() {
  let listener: ((event: any) => void) | null = null;
  return {
    client: {
      async connect() {},
      subscribe(_topic: string, next: (event: any) => void) {
        listener = next;
        return () => {
          listener = null;
        };
      }
    },
    emit(projects: TuttidUserProject[]) {
      listener?.({ payload: { projects } });
    }
  };
}

type DesktopWorkspaceUserProjectServiceTestHostFilesApi = Pick<
  DesktopHostFilesApi,
  "createUserDocumentsProjectDirectory" | "selectDirectory"
>;

type DesktopWorkspaceUserProjectServiceTestTuttidClient = Pick<
  TuttidClient,
  | "checkUserProjectPath"
  | "deleteUserProject"
  | "listUserProjects"
  | "moveUserProject"
  | "pinUserProject"
  | "useUserProject"
>;

type DesktopWorkspaceUserProjectServiceTestPlatformApi = Pick<
  DesktopPlatformApi,
  "homeDirectory" | "os"
>;

function createHostFilesApi(
  overrides: Partial<DesktopWorkspaceUserProjectServiceTestHostFilesApi> = {}
): DesktopWorkspaceUserProjectServiceTestHostFilesApi {
  return {
    async createUserDocumentsProjectDirectory(input) {
      return { path: `/Users/local/Documents/tutti/${input.name}` };
    },
    async selectDirectory() {
      return null;
    },
    ...overrides
  };
}

function createTuttidClient(
  overrides: Partial<DesktopWorkspaceUserProjectServiceTestTuttidClient> = {}
): DesktopWorkspaceUserProjectServiceTestTuttidClient {
  return {
    async checkUserProjectPath(input) {
      return {
        exists: true,
        isDirectory: true,
        path: input.path
      };
    },
    async listUserProjects() {
      return { projects: [] };
    },
    async moveUserProject() {
      return { projects: [] };
    },
    async pinUserProject() {
      return { projects: [] };
    },
    async deleteUserProject() {},
    async useUserProject(input) {
      return createProject({ path: input.path });
    },
    ...overrides
  };
}

function createPlatformApi(
  overrides: Partial<DesktopWorkspaceUserProjectServiceTestPlatformApi> = {}
): DesktopWorkspaceUserProjectServiceTestPlatformApi {
  return {
    homeDirectory: "/Users/local",
    os: "darwin",
    ...overrides
  };
}

function createProject(
  overrides: Partial<TuttidUserProject> = {}
): TuttidUserProject {
  const path = overrides.path ?? "/workspace/project";
  return {
    createdAtUnixMs: 1,
    id: "project-1",
    label: path.split("/").filter(Boolean).at(-1) ?? "Project",
    path,
    updatedAtUnixMs: 1,
    ...overrides,
    lastUsedAtUnixMs: overrides.lastUsedAtUnixMs ?? 1,
    pinnedAtUnixMs: overrides.pinnedAtUnixMs ?? 0,
    sectionKey: overrides.sectionKey ?? `project:${path}`
  };
}

function createNotificationService(
  notifications: Array<{ title: string }>
): NotificationService {
  return {
    _serviceBrand: undefined,
    error(input) {
      notifications.push({ title: input.title });
    },
    info() {},
    notify(input) {
      notifications.push({ title: input.title });
    },
    success() {},
    warning() {}
  };
}

function createDeferred<T>(): {
  promise: Promise<T>;
  reject(error: unknown): void;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}
