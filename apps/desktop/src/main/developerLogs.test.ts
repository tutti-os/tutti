import assert from "node:assert/strict";
import { mkdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { inflateRawSync } from "node:zlib";
import { createDeveloperLogsService } from "./developerLogs.ts";
import type { DeveloperLogsAgentSessionRecord } from "./developerLogsAgentSessions.ts";
import { workspaceAppScopeSegment } from "./host/workspaceAppFolderPaths.ts";

test("developer logs service summarizes managed desktop and daemon logs", async () => {
  const root = join(tmpdir(), `tutti-developer-logs-${Date.now()}`);
  await mkdir(root, { recursive: true });
  const logsDir = join(root, "logs");
  await mkdir(logsDir, { recursive: true });

  await writeFile(join(logsDir, "tuttid.log"), "daemon-1234");
  await writeFile(join(logsDir, "tutti-desktop.log"), "desktop-12");
  await writeFile(join(logsDir, "tuttid.2026-05-23.log"), "rotated");
  await writeFile(join(logsDir, "other.log"), "ignored");

  const service = createDeveloperLogsService({
    defaults: {
      state: {
        desktopLogPath: join(logsDir, "tutti-desktop.log"),
        logsDir,
        tuttidDBPath: "",
        tuttidListenerInfoPath: "",
        tuttidLogPath: join(logsDir, "tuttid.log"),
        tuttidPIDPath: "",
        rootDir: root,
        runDir: ""
      }
    },
    desktopVersion: "1.2.3",
    preferredSystemLanguages: ["en-US"],
    systemLocale: "en",
    transportSnapshot: { kind: "unix", socketPath: "/tmp/tutti.sock" }
  });

  const state = await service.getLogsState();

  assert.equal(state.desktopVersion, "1.2.3");
  assert.equal(state.totalFiles, 3);
  assert.equal(
    state.totalSizeBytes,
    "daemon-1234".length + "desktop-12".length + "rotated".length
  );
  assert.deepEqual(
    state.files.map((file) => [file.kind, file.exists, file.sizeBytes]),
    [
      ["daemon", true, "daemon-1234".length],
      ["desktop", true, "desktop-12".length]
    ]
  );
});

test("developer logs service truncates active logs, removes rotated logs, and clears app and factory logs", async () => {
  const root = join(tmpdir(), `tutti-developer-clear-${Date.now()}`);
  await mkdir(root, { recursive: true });
  const logsDir = join(root, "logs");
  await mkdir(logsDir, { recursive: true });

  const daemonPath = join(logsDir, "tuttid.log");
  const desktopPath = join(logsDir, "tutti-desktop.log");
  const rotatedPath = join(logsDir, "tutti-desktop.2026-05-23.log");
  const appID = "app.alpha";
  const workspaceID = "workspace-1";
  const appLogPath = join(
    root,
    "apps",
    "installations",
    appID,
    workspaceAppScopeSegment(workspaceID, appID),
    "logs",
    "runtime.log"
  );
  const factoryLogPath = join(
    root,
    "apps",
    "factory",
    "jobs",
    "job-1",
    "logs",
    "factory.log"
  );
  await mkdir(dirname(appLogPath), { recursive: true });
  await mkdir(dirname(factoryLogPath), { recursive: true });
  await writeFile(daemonPath, "daemon-live");
  await writeFile(desktopPath, "desktop-live");
  await writeFile(rotatedPath, "rotated-history");
  await writeFile(appLogPath, "app-runtime");
  await writeFile(factoryLogPath, "factory-runtime");

  const service = createDeveloperLogsService({
    defaults: {
      state: {
        desktopLogPath: desktopPath,
        logsDir,
        tuttidDBPath: "",
        tuttidListenerInfoPath: "",
        tuttidLogPath: daemonPath,
        tuttidPIDPath: "",
        rootDir: root,
        runDir: ""
      }
    },
    desktopVersion: "1.2.3",
    preferredSystemLanguages: ["en-US"],
    systemLocale: "en",
    transportSnapshot: { kind: "unix", socketPath: "/tmp/tutti.sock" }
  });

  const result = await service.clearLogs();
  const after = await service.getLogsState();

  assert.equal(result.clearedFiles, 5);
  assert.equal(after.totalFiles, 2);
  assert.equal(after.totalSizeBytes, 0);
  assert.deepEqual(
    after.files.map((file) => file.sizeBytes),
    [0, 0]
  );
});

test("developer logs service exports managed logs into a zip archive", async () => {
  const root = join(tmpdir(), `tutti-developer-export-${Date.now()}`);
  await mkdir(root, { recursive: true });
  const logsDir = join(root, "logs");
  const downloadsDir = join(root, "downloads");
  await mkdir(logsDir, { recursive: true });
  await mkdir(downloadsDir, { recursive: true });

  await writeFile(join(logsDir, "tuttid.log"), "daemon-export");
  await writeFile(join(logsDir, "tutti-desktop.log"), "desktop-export");

  const service = createDeveloperLogsService({
    defaults: {
      state: {
        desktopLogPath: join(logsDir, "tutti-desktop.log"),
        logsDir,
        tuttidDBPath: "",
        tuttidListenerInfoPath: "",
        tuttidLogPath: join(logsDir, "tuttid.log"),
        tuttidPIDPath: "",
        rootDir: root,
        runDir: ""
      }
    },
    desktopVersion: "1.2.3",
    getDownloadsPath: () => downloadsDir,
    now: () => new Date(Date.now() + 60_000),
    preferredSystemLanguages: ["en-US", "zh-CN"],
    systemLocale: "en",
    transportSnapshot: { kind: "unix", socketPath: "/tmp/tutti.sock" }
  });

  const result = await service.exportLogs();

  assert.equal(result.canceled, false);
  assert.equal(result.fileCount, 2);
  assert.ok(result.filePath);
  const zipBytes = await readFile(result.filePath);
  assert.ok(zipBytes.byteLength > 0);
  assert.equal(result.filePath.endsWith(".zip"), true);
  const zipText = zipBytes.toString("utf8");
  assert.equal(zipText.includes("runtime-context.json"), true);
  assert.equal(zipText.includes("export-summary.json"), true);
  assert.equal(zipText.includes("manifest.json"), false);
});

test("developer logs service exports only log content from the last ten minutes without reading sessions", async () => {
  const root = join(tmpdir(), `tutti-developer-recent-export-${Date.now()}`);
  const logsDir = join(root, "logs");
  const downloadsDir = join(root, "downloads");
  const runtimeLogPath = join(
    root,
    "apps",
    "installations",
    "app.alpha",
    workspaceAppScopeSegment("workspace-1", "app.alpha"),
    "logs",
    "runtime.log"
  );
  const oldRotatedLogPath = join(logsDir, "tuttid.2026-07-20.log");
  await mkdir(dirname(runtimeLogPath), { recursive: true });
  await mkdir(logsDir, { recursive: true });
  await mkdir(downloadsDir, { recursive: true });

  await writeFile(
    join(logsDir, "tuttid.log"),
    [
      "time=2026-07-20T11:49:59.999Z level=info msg=old",
      "time=2026-07-20T11:50:00.000Z level=info msg=boundary",
      "time=2026-07-20T11:58:00.000Z level=error msg=recent",
      "time=2026-07-20T12:00:00.001Z level=info msg=future"
    ].join("\n") + "\n"
  );
  await writeFile(
    runtimeLogPath,
    "recent app output referencing 2020-01-01T00:00:00Z snapshot\n"
  );
  await writeFile(oldRotatedLogPath, "old unstructured daemon output\n");
  await utimes(
    runtimeLogPath,
    new Date("2026-07-20T11:58:00.000Z"),
    new Date("2026-07-20T11:58:00.000Z")
  );
  await utimes(
    oldRotatedLogPath,
    new Date("2026-07-20T11:40:00.000Z"),
    new Date("2026-07-20T11:40:00.000Z")
  );

  let agentSessionsRequested = false;
  const service = createDeveloperLogsService({
    agentSessionsProvider: async () => {
      agentSessionsRequested = true;
      return [];
    },
    defaults: {
      state: {
        desktopLogPath: join(logsDir, "tutti-desktop.log"),
        logsDir,
        tuttidDBPath: "",
        tuttidListenerInfoPath: "",
        tuttidLogPath: join(logsDir, "tuttid.log"),
        tuttidPIDPath: "",
        rootDir: root,
        runDir: ""
      }
    },
    desktopVersion: "1.2.3",
    getDownloadsPath: () => downloadsDir,
    now: () => new Date("2026-07-20T12:00:00.000Z")
  });

  const result = await service.exportLogs({
    includeAgentSessions: false,
    scope: "recent-10-minutes"
  });

  assert.equal(agentSessionsRequested, false);
  assert.equal(result.fileCount, 2);
  assert.ok(result.filePath);
  assert.match(result.filePath, /tutti-logs-last-10-minutes-/);
  const entries = readZipEntries(await readFile(result.filePath));
  const daemonLog = entries.get("logs/tuttid.log")?.toString("utf8");
  assert.equal(
    daemonLog,
    [
      "time=2026-07-20T11:50:00.000Z level=info msg=boundary",
      "time=2026-07-20T11:58:00.000Z level=error msg=recent"
    ].join("\n") + "\n"
  );
  assert.equal(
    entries
      .get(
        `app-logs/app.alpha/${workspaceAppScopeSegment("workspace-1", "app.alpha")}/runtime.log`
      )
      ?.toString("utf8"),
    "recent app output referencing 2020-01-01T00:00:00Z snapshot\n"
  );
  assert.equal(entries.has("logs/tuttid.2026-07-20.log"), false);
  assert.equal(
    entries.has(
      "agent-sessions/codex/workspace-1/old-agent-session/session.json"
    ),
    false
  );
  const exportSummary = JSON.parse(
    entries.get("export-summary.json")?.toString("utf8") ?? "{}"
  ) as Record<string, unknown>;
  assert.equal(exportSummary.scope, "recent-10-minutes");
  assert.equal(exportSummary.includeAgentSessions, false);
  assert.equal(exportSummary.windowStart, "2026-07-20T11:50:00.000Z");
});

test("developer logs service exports three days of logs with matching session records", async () => {
  const root = join(tmpdir(), `tutti-developer-three-day-export-${Date.now()}`);
  const logsDir = join(root, "logs");
  const downloadsDir = join(root, "downloads");
  await mkdir(logsDir, { recursive: true });
  await mkdir(downloadsDir, { recursive: true });
  await writeFile(
    join(logsDir, "tuttid.log"),
    [
      "time=2026-07-17T11:59:59.999Z level=info msg=old",
      "time=2026-07-17T12:00:00.000Z level=info msg=boundary",
      "time=2026-07-20T11:59:00.000Z level=info msg=recent"
    ].join("\n") + "\n"
  );

  const createSession = (
    agentSessionID: string,
    updatedAt: string
  ): DeveloperLogsAgentSessionRecord => ({
    agentSessionID,
    hasMoreMessages: false,
    latestMessageVersion: 1,
    messages: [],
    provider: "codex",
    providerSessionID: `provider-${agentSessionID}`,
    session: {
      id: agentSessionID,
      provider: "codex",
      providerSessionId: `provider-${agentSessionID}`,
      createdAt: updatedAt,
      updatedAt
    },
    updatedAtUnixMS: Date.parse(updatedAt),
    workspaceID: "workspace-1"
  });
  const service = createDeveloperLogsService({
    agentSessionsProvider: async () => [
      createSession("recent-session", "2026-07-19T12:00:00.000Z"),
      createSession("old-session", "2026-07-17T11:59:59.999Z")
    ],
    defaults: {
      state: {
        desktopLogPath: join(logsDir, "tutti-desktop.log"),
        logsDir,
        tuttidDBPath: "",
        tuttidListenerInfoPath: "",
        tuttidLogPath: join(logsDir, "tuttid.log"),
        tuttidPIDPath: "",
        rootDir: root,
        runDir: ""
      }
    },
    desktopVersion: "1.2.3",
    getDownloadsPath: () => downloadsDir,
    now: () => new Date("2026-07-20T12:00:00.000Z")
  });

  const result = await service.exportLogs({
    includeAgentSessions: true,
    scope: "recent-3-days"
  });

  assert.equal(result.fileCount, 4);
  assert.ok(result.filePath);
  assert.match(result.filePath, /tutti-logs-last-3-days-with-sessions-/);
  const entries = readZipEntries(await readFile(result.filePath));
  assert.equal(
    entries.get("logs/tuttid.log")?.toString("utf8"),
    [
      "time=2026-07-17T12:00:00.000Z level=info msg=boundary",
      "time=2026-07-20T11:59:00.000Z level=info msg=recent"
    ].join("\n") + "\n"
  );
  assert.equal(
    entries.has("agent-sessions/codex/workspace-1/recent-session/session.json"),
    true
  );
  assert.equal(
    entries.has("agent-sessions/codex/workspace-1/old-session/session.json"),
    false
  );
  const exportSummary = JSON.parse(
    entries.get("export-summary.json")?.toString("utf8") ?? "{}"
  ) as Record<string, unknown>;
  assert.equal(exportSummary.scope, "recent-3-days");
  assert.equal(exportSummary.includeAgentSessions, true);
  assert.equal(exportSummary.windowStart, "2026-07-17T12:00:00.000Z");
});

test("developer logs service exports provider session records from tuttid snapshots", async () => {
  const root = join(tmpdir(), `tutti-developer-agent-export-${Date.now()}`);
  await mkdir(root, { recursive: true });
  const logsDir = join(root, "logs");
  const downloadsDir = join(root, "downloads");
  await mkdir(logsDir, { recursive: true });
  await mkdir(downloadsDir, { recursive: true });

  const workspaceID = "workspace-1";

  const service = createDeveloperLogsService({
    agentSessionsProvider: async () => [
      {
        agentSessionID: "agent-codex",
        hasMoreMessages: false,
        latestMessageVersion: 7,
        messages: [
          {
            agentSessionId: "agent-codex",
            id: 1,
            kind: "text",
            messageId: "codex-message",
            role: "assistant",
            version: 7
          }
        ],
        provider: "codex",
        providerSessionID: "provider-codex",
        session: {
          id: "agent-codex",
          provider: "codex",
          providerSessionId: "provider-codex",
          createdAt: "2026-06-10T00:00:00Z",
          updatedAt: "2026-06-10T00:00:20Z"
        },
        updatedAtUnixMS: 20,
        workspaceID
      },
      {
        agentSessionID: "agent-claude",
        hasMoreMessages: false,
        latestMessageVersion: 3,
        messages: [
          {
            agentSessionId: "agent-claude",
            id: 2,
            kind: "text",
            messageId: "claude-message",
            role: "assistant",
            version: 3
          }
        ],
        provider: "claude-code",
        providerSessionID: "provider-claude",
        session: {
          id: "agent-claude",
          provider: "claude-code",
          providerSessionId: "provider-claude",
          createdAt: "2026-06-10T00:00:00Z",
          updatedAt: "2026-06-10T00:00:10Z"
        },
        updatedAtUnixMS: 10,
        workspaceID
      }
    ],
    defaults: {
      state: {
        desktopLogPath: join(logsDir, "tutti-desktop.log"),
        logsDir,
        tuttidDBPath: "",
        tuttidListenerInfoPath: "",
        tuttidLogPath: join(logsDir, "tuttid.log"),
        tuttidPIDPath: "",
        rootDir: root,
        runDir: ""
      }
    },
    desktopVersion: "1.2.3",
    getDownloadsPath: () => downloadsDir,
    now: () => new Date(30)
  });

  const result = await service.exportLogs();

  assert.equal(result.fileCount, 6);
  assert.ok(result.filePath);
  const zipText = (await readFile(result.filePath)).toString("utf8");
  assert.equal(
    zipText.includes(
      "agent-sessions/codex/workspace-1/agent-codex/manifest.json"
    ),
    true
  );
  assert.equal(
    zipText.includes(
      "agent-sessions/codex/workspace-1/agent-codex/session.json"
    ),
    true
  );
  assert.equal(
    zipText.includes(
      "agent-sessions/codex/workspace-1/agent-codex/messages.jsonl"
    ),
    true
  );
  assert.equal(
    zipText.includes(
      "agent-sessions/claude-code/workspace-1/agent-claude/manifest.json"
    ),
    true
  );
});

test("developer logs service exports at most ten provider session records per provider", async () => {
  const root = join(tmpdir(), `tutti-developer-agent-limit-${Date.now()}`);
  await mkdir(root, { recursive: true });
  const logsDir = join(root, "logs");
  const downloadsDir = join(root, "downloads");
  await mkdir(logsDir, { recursive: true });
  await mkdir(downloadsDir, { recursive: true });

  const workspaceID = "workspace-1";
  const sessions: DeveloperLogsAgentSessionRecord[] = [];
  for (let index = 0; index < 11; index += 1) {
    const agentSessionID = `agent-${index}`;
    const providerSessionID = `provider-${index}`;
    sessions.push({
      agentSessionID,
      hasMoreMessages: false,
      latestMessageVersion: index,
      messages: [
        {
          agentSessionId: agentSessionID,
          id: index,
          kind: "text",
          messageId: `message-${index}`,
          role: "assistant",
          version: index
        }
      ],
      provider: "codex" as const,
      providerSessionID,
      session: {
        id: agentSessionID,
        provider: "codex",
        providerSessionId: providerSessionID,
        createdAt: "2026-06-10T00:00:00Z",
        updatedAt: `2026-06-10T00:00:${String(index).padStart(2, "0")}Z`
      },
      updatedAtUnixMS: index,
      workspaceID
    });
  }

  const service = createDeveloperLogsService({
    agentSessionsProvider: async () => sessions,
    defaults: {
      state: {
        desktopLogPath: join(logsDir, "tutti-desktop.log"),
        logsDir,
        tuttidDBPath: "",
        tuttidListenerInfoPath: "",
        tuttidLogPath: join(logsDir, "tuttid.log"),
        tuttidPIDPath: "",
        rootDir: root,
        runDir: ""
      }
    },
    desktopVersion: "1.2.3",
    getDownloadsPath: () => downloadsDir,
    now: () => new Date(10)
  });

  const result = await service.exportLogs();

  assert.equal(result.fileCount, 30);
  assert.ok(result.filePath);
  const zipText = (await readFile(result.filePath)).toString("utf8");
  assert.equal(
    zipText.includes("agent-sessions/codex/workspace-1/agent-0/manifest.json"),
    false
  );
  assert.equal(
    zipText.includes("agent-sessions/codex/workspace-1/agent-1/manifest.json"),
    true
  );
  assert.equal(
    zipText.includes("agent-sessions/codex/workspace-1/agent-10/manifest.json"),
    true
  );
});

test("developer logs service flushes active desktop logs before export", async () => {
  const root = join(tmpdir(), `tutti-developer-export-flush-${Date.now()}`);
  await mkdir(root, { recursive: true });
  const logsDir = join(root, "logs");
  const downloadsDir = join(root, "downloads");
  const desktopLogPath = join(logsDir, "tutti-desktop.log");
  await mkdir(logsDir, { recursive: true });
  await mkdir(downloadsDir, { recursive: true });
  await writeFile(join(logsDir, "tuttid.log"), "daemon-export");
  await writeFile(desktopLogPath, "");

  let flushed = false;
  const service = createDeveloperLogsService({
    defaults: {
      state: {
        desktopLogPath,
        logsDir,
        tuttidDBPath: "",
        tuttidListenerInfoPath: "",
        tuttidLogPath: join(logsDir, "tuttid.log"),
        tuttidPIDPath: "",
        rootDir: root,
        runDir: ""
      }
    },
    desktopVersion: "1.2.3",
    flushLogs: async () => {
      flushed = true;
      await writeFile(desktopLogPath, "desktop-after-flush");
    },
    getDownloadsPath: () => downloadsDir
  });

  const result = await service.exportLogs();

  assert.equal(flushed, true);
  assert.equal(result.canceled, false);
  assert.ok(result.filePath);
  assert.equal(await readFile(desktopLogPath, "utf8"), "desktop-after-flush");
});

test("developer logs service exports workspace app log files", async () => {
  const root = join(tmpdir(), `tutti-developer-app-export-${Date.now()}`);
  await mkdir(root, { recursive: true });
  const logsDir = join(root, "logs");
  const downloadsDir = join(root, "downloads");
  const appScope = workspaceAppScopeSegment("workspace-1", "app.alpha");
  const appLogsDir = join(
    root,
    "apps",
    "installations",
    "app.alpha",
    appScope,
    "logs"
  );
  const nestedAppLogsDir = join(appLogsDir, "nested");
  await mkdir(logsDir, { recursive: true });
  await mkdir(downloadsDir, { recursive: true });
  await mkdir(nestedAppLogsDir, { recursive: true });

  await writeFile(join(appLogsDir, "runtime.log"), "app-runtime");
  await writeFile(join(nestedAppLogsDir, "custom.LOG"), "app-custom");
  await writeFile(join(appLogsDir, "events.jsonl"), "app-events");

  const service = createDeveloperLogsService({
    defaults: {
      state: {
        desktopLogPath: join(logsDir, "tutti-desktop.log"),
        logsDir,
        tuttidDBPath: "",
        tuttidListenerInfoPath: "",
        tuttidLogPath: join(logsDir, "tuttid.log"),
        tuttidPIDPath: "",
        rootDir: root,
        runDir: ""
      }
    },
    desktopVersion: "1.2.3",
    getDownloadsPath: () => downloadsDir,
    now: () => new Date(Date.now() + 60_000),
    preferredSystemLanguages: ["en-US", "zh-CN"],
    systemLocale: "en",
    transportSnapshot: { kind: "unix", socketPath: "/tmp/tutti.sock" }
  });

  const result = await service.exportLogs();

  assert.equal(result.canceled, false);
  assert.equal(result.fileCount, 3);
  assert.ok(result.filePath);
  const zipText = (await readFile(result.filePath)).toString("utf8");
  assert.equal(
    zipText.includes(`app-logs/app.alpha/${appScope}/runtime.log`),
    true
  );
  assert.equal(
    zipText.includes(`app-logs/app.alpha/${appScope}/nested/custom.LOG`),
    true
  );
  assert.equal(
    zipText.includes(`app-logs/app.alpha/${appScope}/events.jsonl`),
    true
  );
});

test("developer logs service exports app factory job log files", async () => {
  const root = join(tmpdir(), `tutti-developer-factory-export-${Date.now()}`);
  await mkdir(root, { recursive: true });
  const logsDir = join(root, "logs");
  const downloadsDir = join(root, "downloads");
  const factoryLogsDir = join(root, "apps", "factory", "jobs", "job-1", "logs");
  const nestedFactoryLogsDir = join(factoryLogsDir, "nested");
  await mkdir(logsDir, { recursive: true });
  await mkdir(downloadsDir, { recursive: true });
  await mkdir(nestedFactoryLogsDir, { recursive: true });

  await writeFile(join(factoryLogsDir, "factory.log"), "factory-runtime");
  await writeFile(join(nestedFactoryLogsDir, "prepare.LOG"), "factory-prepare");

  const service = createDeveloperLogsService({
    defaults: {
      state: {
        desktopLogPath: join(logsDir, "tutti-desktop.log"),
        logsDir,
        tuttidDBPath: "",
        tuttidListenerInfoPath: "",
        tuttidLogPath: join(logsDir, "tuttid.log"),
        tuttidPIDPath: "",
        rootDir: root,
        runDir: ""
      }
    },
    desktopVersion: "1.2.3",
    getDownloadsPath: () => downloadsDir,
    now: () => new Date(Date.now() + 60_000),
    preferredSystemLanguages: ["en-US", "zh-CN"],
    systemLocale: "en",
    transportSnapshot: { kind: "unix", socketPath: "/tmp/tutti.sock" }
  });

  const result = await service.exportLogs();

  assert.equal(result.canceled, false);
  assert.equal(result.fileCount, 2);
  assert.ok(result.filePath);
  const zipText = (await readFile(result.filePath)).toString("utf8");
  assert.equal(zipText.includes("app-factory-logs/job-1/factory.log"), true);
  assert.equal(
    zipText.includes("app-factory-logs/job-1/nested/prepare.LOG"),
    true
  );
});

test("developer logs service exports app center snapshot", async () => {
  const root = join(tmpdir(), `tutti-developer-app-center-${Date.now()}`);
  await mkdir(root, { recursive: true });
  const logsDir = join(root, "logs");
  const downloadsDir = join(root, "downloads");
  await mkdir(logsDir, { recursive: true });
  await mkdir(downloadsDir, { recursive: true });

  const service = createDeveloperLogsService({
    appCenterSnapshotProvider: async () => ({
      workspaces: [
        {
          appFactoryJobsResponse: {
            jobs: [
              {
                appId: "app_answer_book",
                displayName: "答案之书",
                failureReason: null,
                jobId: "job-answer",
                publishedVersion: "0.1.0",
                status: "published",
                updatedAtUnixMs: 123
              }
            ],
            workspaceId: "workspace-1"
          },
          appsResponse: {
            apps: [
              {
                appId: "app_answer_book",
                enabled: true,
                installed: true,
                source: "generated",
                version: "0.1.0"
              }
            ],
            workspaceId: "workspace-1"
          },
          workspaceId: "workspace-1"
        }
      ]
    }),
    defaults: {
      state: {
        desktopLogPath: join(logsDir, "tutti-desktop.log"),
        logsDir,
        tuttidDBPath: "",
        tuttidListenerInfoPath: "",
        tuttidLogPath: join(logsDir, "tuttid.log"),
        tuttidPIDPath: "",
        rootDir: root,
        runDir: ""
      }
    },
    desktopVersion: "1.2.3",
    getDownloadsPath: () => downloadsDir,
    preferredSystemLanguages: ["en-US", "zh-CN"],
    systemLocale: "en",
    transportSnapshot: { kind: "unix", socketPath: "/tmp/tutti.sock" }
  });

  const result = await service.exportLogs();

  assert.equal(result.canceled, false);
  assert.ok(result.filePath);
  const zipText = (await readFile(result.filePath)).toString("utf8");
  assert.equal(zipText.includes("app-center-snapshot.json"), true);
});

function readZipEntries(archive: Buffer): Map<string, Buffer> {
  const endOfCentralDirectorySignature = 0x06054b50;
  const centralDirectoryEntrySignature = 0x02014b50;
  const localFileHeaderSignature = 0x04034b50;
  let endOfCentralDirectoryOffset = -1;
  for (let offset = archive.length - 22; offset >= 0; offset -= 1) {
    if (archive.readUInt32LE(offset) === endOfCentralDirectorySignature) {
      endOfCentralDirectoryOffset = offset;
      break;
    }
  }
  assert.notEqual(endOfCentralDirectoryOffset, -1);

  const entries = new Map<string, Buffer>();
  const entryCount = archive.readUInt16LE(endOfCentralDirectoryOffset + 10);
  let centralOffset = archive.readUInt32LE(endOfCentralDirectoryOffset + 16);

  for (let index = 0; index < entryCount; index += 1) {
    assert.equal(
      archive.readUInt32LE(centralOffset),
      centralDirectoryEntrySignature
    );
    const compressionMethod = archive.readUInt16LE(centralOffset + 10);
    const compressedSize = archive.readUInt32LE(centralOffset + 20);
    const fileNameLength = archive.readUInt16LE(centralOffset + 28);
    const extraFieldLength = archive.readUInt16LE(centralOffset + 30);
    const commentLength = archive.readUInt16LE(centralOffset + 32);
    const localHeaderOffset = archive.readUInt32LE(centralOffset + 42);
    const fileName = archive
      .subarray(centralOffset + 46, centralOffset + 46 + fileNameLength)
      .toString("utf8");

    assert.equal(
      archive.readUInt32LE(localHeaderOffset),
      localFileHeaderSignature
    );
    const localFileNameLength = archive.readUInt16LE(localHeaderOffset + 26);
    const localExtraFieldLength = archive.readUInt16LE(localHeaderOffset + 28);
    const contentOffset =
      localHeaderOffset + 30 + localFileNameLength + localExtraFieldLength;
    const compressedContent = archive.subarray(
      contentOffset,
      contentOffset + compressedSize
    );
    const content =
      compressionMethod === 0
        ? compressedContent
        : inflateRawSync(compressedContent);
    entries.set(fileName, content);

    centralOffset += 46 + fileNameLength + extraFieldLength + commentLength;
  }

  return entries;
}

test("developer logs service treats .LOG files as managed logs", async () => {
  const root = join(tmpdir(), `tutti-developer-uppercase-${Date.now()}`);
  await mkdir(root, { recursive: true });
  const logsDir = join(root, "logs");
  await mkdir(logsDir, { recursive: true });

  await writeFile(join(logsDir, "TUTTID.LOG"), "daemon-upper");
  await writeFile(
    join(logsDir, "tutti-desktop.2026-05-24.LOG"),
    "desktop-rotated-upper"
  );

  const service = createDeveloperLogsService({
    defaults: {
      state: {
        desktopLogPath: join(logsDir, "TUTTI-DESKTOP.LOG"),
        logsDir,
        tuttidDBPath: "",
        tuttidListenerInfoPath: "",
        tuttidLogPath: join(logsDir, "TUTTID.LOG"),
        tuttidPIDPath: "",
        rootDir: root,
        runDir: ""
      }
    },
    desktopVersion: "1.2.3",
    preferredSystemLanguages: ["en-US"],
    systemLocale: "en",
    transportSnapshot: { kind: "unix", socketPath: "/tmp/tutti.sock" }
  });

  const state = await service.getLogsState();

  assert.equal(state.totalFiles, 2);
  assert.equal(
    state.totalSizeBytes,
    "daemon-upper".length + "desktop-rotated-upper".length
  );
});

test("developer logs service does not clear generated diagnostics", async () => {
  const root = join(tmpdir(), `tutti-developer-clear-generated-${Date.now()}`);
  await mkdir(root, { recursive: true });
  const logsDir = join(root, "logs");
  const downloadsDir = join(root, "downloads");
  const appID = "app.alpha";
  const workspaceID = "workspace-1";
  const appLogPath = join(
    root,
    "apps",
    "installations",
    appID,
    workspaceAppScopeSegment(workspaceID, appID),
    "logs",
    "events.jsonl"
  );
  await mkdir(logsDir, { recursive: true });
  await mkdir(downloadsDir, { recursive: true });
  await mkdir(dirname(appLogPath), { recursive: true });

  const daemonPath = join(logsDir, "tuttid.log");
  const desktopPath = join(logsDir, "tutti-desktop.log");
  await writeFile(daemonPath, "daemon-live");
  await writeFile(desktopPath, "desktop-live");
  await writeFile(appLogPath, "app-events");

  const service = createDeveloperLogsService({
    agentSessionsProvider: async () => [
      {
        agentSessionID: "agent-codex",
        hasMoreMessages: false,
        latestMessageVersion: 1,
        messages: [
          {
            agentSessionId: "agent-codex",
            id: 1,
            kind: "text",
            messageId: "codex-message",
            role: "assistant",
            version: 1
          }
        ],
        provider: "codex",
        providerSessionID: "provider-codex",
        session: {
          id: "agent-codex",
          provider: "codex",
          providerSessionId: "provider-codex",
          createdAt: "2026-06-10T00:00:00Z",
          updatedAt: "2026-06-10T00:00:20Z"
        },
        updatedAtUnixMS: Date.now(),
        workspaceID
      }
    ],
    appCenterSnapshotProvider: async () => ({
      workspaces: [
        {
          appFactoryJobsResponse: { jobs: [], workspaceId: workspaceID },
          appsResponse: { apps: [], workspaceId: workspaceID },
          workspaceId: workspaceID
        }
      ]
    }),
    defaults: {
      state: {
        desktopLogPath: desktopPath,
        logsDir,
        tuttidDBPath: "",
        tuttidListenerInfoPath: "",
        tuttidLogPath: daemonPath,
        tuttidPIDPath: "",
        rootDir: root,
        runDir: ""
      }
    },
    desktopVersion: "1.2.3",
    getDownloadsPath: () => downloadsDir,
    now: () => new Date(Date.now() + 60_000),
    preferredSystemLanguages: ["en-US"],
    systemLocale: "en",
    transportSnapshot: { kind: "unix", socketPath: "/tmp/tutti.sock" }
  });

  const clearResult = await service.clearLogs();
  const exportResult = await service.exportLogs();

  assert.equal(clearResult.clearedFiles, 3);
  assert.equal(await readFile(daemonPath, "utf8"), "");
  assert.equal(await readFile(desktopPath, "utf8"), "");
  await assert.rejects(() => stat(appLogPath));

  assert.equal(exportResult.fileCount, 4);
  assert.ok(exportResult.filePath !== null);
  const zipText = await readFile(exportResult.filePath, "utf8");
  assert.equal(
    zipText.includes(
      "agent-sessions/codex/workspace-1/agent-codex/manifest.json"
    ),
    true
  );
  assert.equal(zipText.includes("app-center-snapshot.json"), true);
});
