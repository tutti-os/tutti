import type { TuttiExternalBridge } from "../../contracts/index.ts";
import type {
  TuttiExternalConformanceInvalidResultFixtures,
  TuttiExternalConformanceOperationFixtures
} from "./types.ts";

const project = deepFreeze({
  createdAtUnixMs: 1,
  id: "project-1",
  label: "Project One",
  path: "/workspace/project-one",
  updatedAtUnixMs: 2
});

const snapshot = deepFreeze({
  error: null,
  initialized: true,
  isLoading: false,
  projects: [project],
  revision: 1
});

const launchInitial = deepFreeze({
  kind: "open-route" as const,
  params: { source: "initial" },
  route: "/initial",
  state: { sequence: 1 }
});

const launchLive = deepFreeze({
  kind: "open-route" as const,
  params: { source: "live" },
  route: "/live",
  state: { sequence: 2 }
});

export const tuttiExternalStable26OperationFixtures = deepFreeze({
  "app.getContext": {
    expectedInput: undefined,
    input: undefined,
    invoke: (bridge: TuttiExternalBridge, _input: undefined) =>
      bridge.app.getContext(),
    kind: "request",
    operation: "app.getContext",
    result: { appId: "fixture-app", workspaceId: "fixture-workspace" }
  },
  "app.subscribe": {
    event: "app.contextChanged",
    initial: { appId: "fixture-app", revision: 1 },
    invoke: (bridge: TuttiExternalBridge, listener: (value: unknown) => void) =>
      bridge.app.subscribe(listener),
    kind: "subscription",
    live: { appId: "fixture-app", revision: 2 },
    operation: "app.subscribe"
  },
  "activity.reportActive": {
    expectedInput: undefined,
    input: undefined,
    invoke: (bridge: TuttiExternalBridge, _input: undefined) =>
      bridge.activity.reportActive(),
    kind: "request",
    operation: "activity.reportActive",
    result: undefined
  },
  "browser.openUrl": {
    expectedInput: { url: "https://example.com/path" },
    input: { url: " https://example.com/path " },
    invoke: (bridge: TuttiExternalBridge, input) =>
      bridge.browser.openUrl(input),
    kind: "notification",
    operation: "browser.openUrl"
  },
  "at.query": {
    expectedInput: {
      keyword: "canvas",
      maxResults: 2,
      providers: ["workspace-app", "agent-target"]
    },
    input: {
      keyword: "canvas",
      maxResults: 2,
      providers: ["workspace-app", "agent-target"]
    },
    invoke: (bridge: TuttiExternalBridge, input) => bridge.at.query(input),
    kind: "request",
    operation: "at.query",
    result: [
      {
        insert: {
          kind: "mention",
          mention: { entityId: "app-1", label: "Canvas" }
        },
        itemId: "app-1",
        label: "Canvas",
        providerId: "workspace-app"
      }
    ]
  },
  "files.select": {
    expectedInput: {},
    input: undefined,
    invoke: (bridge: TuttiExternalBridge, input) => bridge.files.select(input),
    kind: "request",
    operation: "files.select",
    result: [
      {
        displayName: "README.md",
        kind: "file",
        path: "/workspace/README.md",
        sizeBytes: 42
      }
    ]
  },
  "files.open": {
    expectedInput: {
      location: { path: "docs/README.md", type: "app-package-relative" },
      mode: "preview",
      packageVersion: "1.0.0",
      path: "/workspace/README.md"
    },
    input: {
      location: {
        path: " docs/README.md ",
        type: "app-package-relative"
      },
      mode: "preview",
      packageVersion: " 1.0.0 ",
      path: " /workspace/README.md "
    },
    invoke: (bridge: TuttiExternalBridge, input) => bridge.files.open(input),
    kind: "request",
    operation: "files.open",
    result: undefined
  },
  "files.upload": {
    expectedInput: {
      mimeType: "text/plain",
      name: "fixture.txt",
      purpose: "app-asset"
    },
    file: new Blob(["fixture"], { type: "text/plain" }),
    input: { mimeType: " text/plain ", name: " fixture.txt " },
    invoke: (bridge: TuttiExternalBridge, file, input) =>
      bridge.files.upload(file, input),
    kind: "upload",
    operation: "files.upload",
    result: {
      mimeType: "text/plain",
      name: "fixture.txt",
      path: "/uploads/fixture.txt",
      sha256: "fixture-sha256",
      sizeBytes: 7
    }
  },
  "permissions.request": {
    expectedInput: {
      nonce: "nonce-1",
      permission: "managed-ai-models",
      providers: ["openai", "anthropic"],
      scopes: ["models:read"],
      state: "state-1"
    },
    input: {
      nonce: " nonce-1 ",
      permission: "managed-ai-models",
      providers: ["openai", "anthropic"],
      scopes: [" models:read "],
      state: " state-1 "
    },
    invoke: (bridge: TuttiExternalBridge, input) =>
      bridge.permissions.request(input),
    kind: "request",
    operation: "permissions.request",
    result: {
      code: "grant-code",
      models: [{ id: "model-1", name: "Model One", provider: "openai" }],
      providers: ["openai"]
    }
  },
  "settings.open": {
    expectedInput: { provider: "openai", tab: "models" },
    input: { provider: "openai", tab: "models" },
    invoke: (bridge: TuttiExternalBridge, input) => bridge.settings.open(input),
    kind: "request",
    operation: "settings.open",
    result: undefined
  },
  "workspace.onLaunchIntent": {
    event: "workspace.launchIntent",
    initial: launchInitial,
    invoke: (bridge: TuttiExternalBridge, listener: (value: unknown) => void) =>
      bridge.workspace.onLaunchIntent(listener),
    kind: "subscription",
    live: launchLive,
    operation: "workspace.onLaunchIntent"
  },
  "workspace.openFeature": {
    expectedInput: {
      autoSubmit: true,
      draftPrompt: "Review this",
      feature: "agent-chat",
      provider: "codex"
    },
    input: {
      autoSubmit: true,
      draftPrompt: " Review this ",
      feature: "agent-chat",
      provider: "codex"
    },
    invoke: (bridge: TuttiExternalBridge, input) =>
      bridge.workspace.openFeature(input),
    kind: "request",
    operation: "workspace.openFeature",
    result: undefined
  },
  "references.open": {
    expectedInput: { href: "mention://workspace-app/app-1" },
    input: { href: " mention://workspace-app/app-1 " },
    invoke: (bridge: TuttiExternalBridge, input) =>
      bridge.references.open(input),
    kind: "request",
    operation: "references.open",
    result: undefined
  },
  "pdf.printHtmlToPdf": {
    expectedInput: {
      html: "<h1>Fixture</h1>",
      pageSize: "A4",
      title: "Fixture"
    },
    input: {
      html: "<h1>Fixture</h1>",
      pageSize: "A4",
      printBackground: true,
      title: " Fixture "
    },
    invoke: (bridge: TuttiExternalBridge, input) =>
      bridge.pdf.printHtmlToPdf(input),
    kind: "request",
    operation: "pdf.printHtmlToPdf",
    get result() {
      return Object.freeze({ bytes: new Uint8Array([1, 2, 3]) });
    }
  },
  "userProjects.checkPath": {
    expectedInput: { path: "/workspace/project-one" },
    input: { path: " /workspace/project-one " },
    invoke: (bridge: TuttiExternalBridge, input) =>
      bridge.userProjects.checkPath(input),
    kind: "request",
    operation: "userProjects.checkPath",
    result: {
      exists: true,
      isDirectory: true,
      path: "/workspace/project-one"
    }
  },
  "userProjects.create": {
    expectedInput: { name: "Project One" },
    input: { name: " Project One " },
    invoke: (bridge: TuttiExternalBridge, input) =>
      bridge.userProjects.create(input),
    kind: "request",
    operation: "userProjects.create",
    result: project
  },
  "userProjects.getDefaultSelection": {
    expectedInput: undefined,
    input: undefined,
    invoke: (bridge: TuttiExternalBridge, _input: undefined) =>
      bridge.userProjects.getDefaultSelection(),
    kind: "request",
    operation: "userProjects.getDefaultSelection",
    result: { path: "/workspace/project-one" }
  },
  "userProjects.getSnapshot": {
    expectedInput: undefined,
    input: undefined,
    invoke: (bridge: TuttiExternalBridge, _input: undefined) =>
      bridge.userProjects.getSnapshot(),
    kind: "request",
    operation: "userProjects.getSnapshot",
    result: snapshot
  },
  "userProjects.list": {
    expectedInput: undefined,
    input: undefined,
    invoke: (bridge: TuttiExternalBridge, _input: undefined) =>
      bridge.userProjects.list(),
    kind: "request",
    operation: "userProjects.list",
    result: { projects: [project] }
  },
  "userProjects.prepareSelection": {
    expectedInput: {
      projectLocked: false,
      selectedPath: "/workspace/project-one"
    },
    input: {
      projectLocked: false,
      selectedPath: " /workspace/project-one "
    },
    invoke: (bridge: TuttiExternalBridge, input) =>
      bridge.userProjects.prepareSelection(input),
    kind: "request",
    operation: "userProjects.prepareSelection",
    result: {
      isSelectedPathMissing: false,
      projects: [project],
      selection: { kind: "select", path: "/workspace/project-one" }
    }
  },
  "userProjects.refresh": {
    expectedInput: undefined,
    input: undefined,
    invoke: (bridge: TuttiExternalBridge, _input: undefined) =>
      bridge.userProjects.refresh(),
    kind: "request",
    operation: "userProjects.refresh",
    result: snapshot
  },
  "userProjects.rememberDefaultSelection": {
    expectedInput: { path: "/workspace/project-one" },
    input: { path: " /workspace/project-one " },
    invoke: (bridge: TuttiExternalBridge, input) =>
      bridge.userProjects.rememberDefaultSelection(input),
    kind: "request",
    operation: "userProjects.rememberDefaultSelection",
    result: undefined
  },
  "userProjects.selectDirectory": {
    expectedInput: undefined,
    input: undefined,
    invoke: (bridge: TuttiExternalBridge, _input: undefined) =>
      bridge.userProjects.selectDirectory(),
    kind: "request",
    operation: "userProjects.selectDirectory",
    result: { path: "/workspace/selected" }
  },
  "userProjects.subscribe": {
    event: "userProjects.changed",
    initial: snapshot,
    invoke: (bridge: TuttiExternalBridge, listener: (value: unknown) => void) =>
      bridge.userProjects.subscribe(listener),
    kind: "subscription",
    live: { ...snapshot, revision: 2 },
    operation: "userProjects.subscribe"
  },
  "userProjects.use": {
    expectedInput: { path: "/workspace/project-one" },
    input: { path: " /workspace/project-one " },
    invoke: (bridge: TuttiExternalBridge, input) =>
      bridge.userProjects.use(input),
    kind: "request",
    operation: "userProjects.use",
    result: project
  },
  "logs.write": {
    expectedInput: {
      details: { component: "fixture" },
      event: "conformance.event",
      level: "info"
    },
    input: {
      details: { component: "fixture" },
      event: " conformance.event ",
      level: "info"
    },
    invoke: (bridge: TuttiExternalBridge, input) => bridge.logs.write(input),
    kind: "notification",
    operation: "logs.write"
  }
}) satisfies TuttiExternalConformanceOperationFixtures;

export const tuttiExternalStable26InvalidResultFixtures = deepFreeze({
  "activity.reportActive": null,
  "at.query": {},
  "files.select": {},
  "files.open": null,
  "files.upload": {},
  "permissions.request": {},
  "settings.open": null,
  "workspace.openFeature": null,
  "references.open": null,
  "pdf.printHtmlToPdf": { bytes: [] },
  "userProjects.checkPath": {},
  "userProjects.create": {},
  "userProjects.getDefaultSelection": {},
  "userProjects.getSnapshot": {},
  "userProjects.list": {},
  "userProjects.prepareSelection": {},
  "userProjects.refresh": {},
  "userProjects.rememberDefaultSelection": null,
  "userProjects.selectDirectory": {},
  "userProjects.use": {}
}) satisfies TuttiExternalConformanceInvalidResultFixtures;

function deepFreeze<T>(value: T): T {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function") ||
    Object.isFrozen(value)
  ) {
    return value;
  }
  if (ArrayBuffer.isView(value)) {
    throw new TypeError(
      "shared conformance typed arrays must be exposed through fresh-value accessors"
    );
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && "value" in descriptor) {
      deepFreeze(descriptor.value);
    }
  }
  return Object.freeze(value);
}
