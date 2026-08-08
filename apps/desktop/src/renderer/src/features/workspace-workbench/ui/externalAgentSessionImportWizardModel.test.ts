import assert from "node:assert/strict";
import test from "node:test";
import {
  externalImportGroupsFromScan,
  externalImportRequestSource,
  externalImportScanRequest,
  externalImportScanSource,
  externalImportScanStateReducer,
  externalImportSelectionProjects,
  externalImportUsableScanCatalog,
  filterExternalImportGroups,
  isExternalImportArchiveMode,
  isExternalImportWizardBusy,
  projectExternalImportScan,
  shouldAllowExternalImportDialogOpenChange
} from "./externalAgentSessionImportWizardModel.ts";

test("archive source keeps the same path and kind for scan and disables project registration", () => {
  assert.equal(isExternalImportArchiveMode(" /tmp/claude-export.zip "), true);
  const source = externalImportScanSource({
    archiveKind: "claude",
    archivePath: " /tmp/claude-export.zip ",
    providers: ["codex", "claude-code"]
  });
  assert.deepEqual(externalImportScanRequest(source), {
    archivePath: "/tmp/claude-export.zip",
    archiveKind: "claude",
    days: -1
  });
  assert.deepEqual(
    externalImportRequestSource(" /tmp/claude-export.zip ", "claude", true),
    {
      archivePath: "/tmp/claude-export.zip",
      archiveKind: "claude",
      registerUserProjects: false
    }
  );
});

test("chatgpt archive source threads its kind through scan and import requests", () => {
  const source = externalImportScanSource({
    archiveKind: "chatgpt",
    archivePath: "/tmp/chatgpt-export.zip",
    providers: []
  });
  assert.deepEqual(externalImportScanRequest(source), {
    archivePath: "/tmp/chatgpt-export.zip",
    archiveKind: "chatgpt",
    days: -1
  });
  assert.deepEqual(
    externalImportRequestSource("/tmp/chatgpt-export.zip", "chatgpt", true),
    {
      archivePath: "/tmp/chatgpt-export.zip",
      archiveKind: "chatgpt",
      registerUserProjects: false
    }
  );
});

test("local source requests all history and keeps the project registration preference", () => {
  assert.equal(isExternalImportArchiveMode(null), false);
  assert.deepEqual(
    externalImportScanRequest(
      externalImportScanSource({
        archiveKind: "claude",
        archivePath: null,
        providers: ["codex"]
      })
    ),
    { days: -1, providers: ["codex"] }
  );
  assert.deepEqual(externalImportRequestSource(null, null, false), {
    registerUserProjects: false
  });
});

test("completed scan is reusable for the same provider catalog identity", () => {
  const response = {
    errors: [],
    projects: [],
    providers: [],
    scannedMessages: 0,
    scannedSessions: 0,
    sessions: [],
    skippedSessions: 0
  };
  const source = externalImportScanSource({
    archiveKind: "claude",
    archivePath: "/tmp/claude-export-a.zip",
    providers: ["codex", "claude-code"]
  });
  const state = externalImportScanStateReducer(null, {
    type: "scan-succeeded",
    anchorUnixMs: 123,
    response,
    source
  });

  assert.equal(
    externalImportUsableScanCatalog(state, source)?.response,
    response
  );
  assert.equal(
    externalImportUsableScanCatalog(
      state,
      externalImportScanSource({
        archiveKind: "claude",
        archivePath: "/tmp/claude-export-b.zip",
        providers: ["codex", "claude-code"]
      })
    ),
    null
  );
  assert.equal(
    externalImportUsableScanCatalog(
      state,
      externalImportScanSource({
        archiveKind: "chatgpt",
        archivePath: "/tmp/claude-export-a.zip",
        providers: ["codex", "claude-code"]
      })
    ),
    null,
    "same path but a different archive kind must not reuse the scan"
  );
  assert.equal(
    externalImportUsableScanCatalog(
      state,
      externalImportScanSource({
        archiveKind: "claude",
        archivePath: null,
        providers: ["codex", "claude-code"]
      })
    ),
    null
  );
});

test("local catalog identity ignores provider order and active range", () => {
  const response = {
    errors: [],
    projects: [],
    providers: [],
    scannedMessages: 0,
    scannedSessions: 0,
    sessions: [],
    skippedSessions: 0
  };
  const source = externalImportScanSource({
    archiveKind: "claude",
    archivePath: null,
    providers: ["codex", "claude-code"]
  });
  const state = externalImportScanStateReducer(null, {
    type: "scan-succeeded",
    anchorUnixMs: 123,
    response,
    source
  });

  assert.equal(
    externalImportUsableScanCatalog(
      state,
      externalImportScanSource({
        archiveKind: "claude",
        archivePath: null,
        providers: ["claude-code", "codex"]
      })
    )?.response,
    response
  );
});

test("starting, failing, or changing source clears the completed scan", () => {
  const response = {
    errors: [],
    projects: [],
    providers: [],
    scannedMessages: 0,
    scannedSessions: 0,
    sessions: [],
    skippedSessions: 0
  };
  const source = externalImportScanSource({
    archiveKind: "claude",
    archivePath: "/tmp/claude-export.zip",
    providers: []
  });
  const completed = externalImportScanStateReducer(null, {
    type: "scan-succeeded",
    anchorUnixMs: 123,
    response,
    source
  });

  assert.equal(
    externalImportScanStateReducer(completed, { type: "scan-started" }),
    null
  );
  assert.equal(
    externalImportScanStateReducer(completed, { type: "scan-failed" }),
    null
  );
  assert.equal(
    externalImportScanStateReducer(completed, { type: "source-changed" }),
    null
  );
});

test("projects all supported ranges from one catalog with daemon cutoff semantics", () => {
  const dayMs = 24 * 60 * 60 * 1000;
  const anchorUnixMs = 100 * dayMs;
  const catalog: Parameters<typeof projectExternalImportScan>[0] = {
    errors: [{ provider: "codex", message: "one catalog diagnostic" }],
    projects: [
      {
        path: "/b",
        label: "Beta",
        providers: ["codex"],
        sessionCount: 1,
        messageCount: 5,
        lastUpdatedAtUnixMs: anchorUnixMs - dayMs
      },
      {
        path: "/a",
        label: "Alpha",
        providers: ["claude-code", "codex"],
        sessionCount: 3,
        messageCount: 11,
        lastUpdatedAtUnixMs: anchorUnixMs - 7 * dayMs
      },
      {
        path: "/c",
        label: "Gamma",
        providers: ["codex"],
        sessionCount: 1,
        messageCount: 4,
        lastUpdatedAtUnixMs: anchorUnixMs - 30 * dayMs
      },
      {
        path: "/d",
        label: "Delta",
        providers: ["codex"],
        sessionCount: 1,
        messageCount: 1,
        lastUpdatedAtUnixMs: anchorUnixMs - 90 * dayMs
      }
    ],
    providers: [
      {
        provider: "codex",
        root: "/codex",
        available: true,
        sessionCount: 4,
        messageCount: 12
      },
      {
        provider: "claude-code",
        root: "/claude",
        available: true,
        sessionCount: 2,
        messageCount: 9
      }
    ],
    scannedMessages: 21,
    scannedSessions: 6,
    sessions: [
      {
        id: "recent",
        projectPath: "/b",
        provider: "codex",
        title: "Recent",
        messageCount: 5,
        lastUpdatedAtUnixMs: anchorUnixMs - dayMs
      },
      {
        id: "boundary-7",
        projectPath: "/a",
        provider: "claude-code",
        title: "Seven day boundary",
        messageCount: 3,
        lastUpdatedAtUnixMs: anchorUnixMs - 7 * dayMs
      },
      {
        id: "day-8",
        projectPath: "/a",
        provider: "codex",
        title: "Eight days",
        messageCount: 2,
        lastUpdatedAtUnixMs: anchorUnixMs - 8 * dayMs
      },
      {
        id: "boundary-30",
        projectPath: "/c",
        provider: "codex",
        title: "Thirty day boundary",
        messageCount: 4,
        lastUpdatedAtUnixMs: anchorUnixMs - 30 * dayMs
      },
      {
        id: "boundary-90",
        projectPath: "/d",
        provider: "codex",
        title: "Ninety day boundary",
        messageCount: 1,
        lastUpdatedAtUnixMs: anchorUnixMs - 90 * dayMs
      },
      {
        id: "day-91",
        projectPath: "/a",
        provider: "claude-code",
        title: "Older",
        messageCount: 6,
        lastUpdatedAtUnixMs: anchorUnixMs - 91 * dayMs
      }
    ],
    skippedSessions: 2
  };

  const sevenDays = projectExternalImportScan(catalog, 7, anchorUnixMs);
  assert.deepEqual(
    sevenDays.sessions.map((session) => session.id),
    ["recent", "boundary-7"],
    "the exact cutoff boundary remains included"
  );
  assert.equal(sevenDays.scannedSessions, 2);
  assert.equal(sevenDays.scannedMessages, 8);
  assert.deepEqual(
    sevenDays.projects.map((project) => ({
      path: project.path,
      providers: project.providers,
      sessions: project.sessionCount,
      messages: project.messageCount
    })),
    [
      { path: "/b", providers: ["codex"], sessions: 1, messages: 5 },
      {
        path: "/a",
        providers: ["claude-code"],
        sessions: 1,
        messages: 3
      }
    ]
  );
  assert.deepEqual(
    sevenDays.providers.map((provider) => [
      provider.provider,
      provider.sessionCount,
      provider.messageCount
    ]),
    [
      ["codex", 1, 5],
      ["claude-code", 1, 3]
    ]
  );

  assert.deepEqual(
    projectExternalImportScan(catalog, 30, anchorUnixMs).sessions.map(
      (session) => session.id
    ),
    ["recent", "boundary-7", "day-8", "boundary-30"]
  );
  assert.deepEqual(
    projectExternalImportScan(catalog, 90, anchorUnixMs).sessions.map(
      (session) => session.id
    ),
    ["recent", "boundary-7", "day-8", "boundary-30", "boundary-90"]
  );
  const allHistory = projectExternalImportScan(catalog, -1, anchorUnixMs);
  assert.deepEqual(
    allHistory.sessions.map((session) => session.id),
    catalog.sessions.map((session) => session.id)
  );
  assert.equal(allHistory.scannedSessions, 6);
  assert.equal(allHistory.scannedMessages, 21);
  assert.equal(allHistory.skippedSessions, 2);
  assert.equal(allHistory.errors, catalog.errors);
});

test("range projections preserve deselections when sessions leave and re-enter", () => {
  const anchorUnixMs = 100 * 24 * 60 * 60 * 1000;
  const catalog: Parameters<typeof projectExternalImportScan>[0] = {
    errors: [],
    projects: [
      {
        path: "/project",
        label: "Project",
        providers: ["codex"],
        sessionCount: 2,
        messageCount: 2
      }
    ],
    providers: [
      {
        provider: "codex",
        root: "/codex",
        available: true,
        sessionCount: 2,
        messageCount: 2
      }
    ],
    scannedMessages: 2,
    scannedSessions: 2,
    sessions: [
      {
        id: "recent",
        projectPath: "/project",
        provider: "codex",
        title: "Recent",
        messageCount: 1,
        lastUpdatedAtUnixMs: anchorUnixMs
      },
      {
        id: "older-deselected",
        projectPath: "/project",
        provider: "codex",
        title: "Older",
        messageCount: 1,
        lastUpdatedAtUnixMs: 1
      }
    ],
    skippedSessions: 0
  };
  const deselected = new Set(["older-deselected"]);

  assert.deepEqual(
    externalImportSelectionProjects(
      projectExternalImportScan(catalog, 7, anchorUnixMs).sessions,
      deselected
    ),
    [
      {
        path: "/project",
        providers: ["codex"],
        sessionIds: ["recent"]
      }
    ]
  );
  assert.deepEqual(
    externalImportSelectionProjects(
      projectExternalImportScan(catalog, -1, anchorUnixMs).sessions,
      deselected
    ),
    [
      {
        path: "/project",
        providers: ["codex"],
        sessionIds: ["recent"]
      }
    ]
  );
});

test("archive groups use their source label and preserve selected session ids", () => {
  const scan = {
    errors: [],
    projects: [
      {
        label: "demo",
        messageCount: 3,
        path: "/Users/demo",
        providers: ["claude-code" as const],
        sessionCount: 2
      }
    ],
    providers: [],
    scannedMessages: 3,
    scannedSessions: 2,
    sessions: [
      {
        ...{
          activeTurnId: null,
          latestTurnInteractions: [],
          pendingInteractions: []
        },
        id: "session-new",
        lastUpdatedAtUnixMs: 200,
        messageCount: 2,
        projectPath: "/Users/demo",
        provider: "claude-code" as const,
        sourcePath: "/tmp/claude-export.zip",
        title: "New conversation"
      },
      {
        id: "session-old",
        lastUpdatedAtUnixMs: 100,
        messageCount: 1,
        projectPath: "/Users/demo",
        provider: "claude-code" as const,
        sourcePath: "/tmp/claude-export.zip",
        title: "Old conversation"
      }
    ],
    skippedSessions: 0
  };
  const groups = externalImportGroupsFromScan(
    scan,
    () => "fallback",
    "Claude chats"
  );
  assert.equal(groups[0]?.label, "Claude chats");
  assert.deepEqual(
    filterExternalImportGroups(groups, "new")[0]?.sessions.map(
      (session) => session.id
    ),
    ["session-new"]
  );
  assert.deepEqual(
    externalImportSelectionProjects(scan.sessions, new Set(["session-old"])),
    [
      {
        path: "/Users/demo",
        providers: ["claude-code"],
        sessionIds: ["session-new"]
      }
    ]
  );
});

test("wizard is not busy when idle", () => {
  assert.equal(
    isExternalImportWizardBusy({ importing: false, loading: false }),
    false
  );
});

test("wizard is busy while scanning", () => {
  assert.equal(
    isExternalImportWizardBusy({ importing: false, loading: true }),
    true
  );
});

test("wizard is busy while importing", () => {
  assert.equal(
    isExternalImportWizardBusy({ importing: true, loading: false }),
    true
  );
});

test("blocks the X close button (onOpenChange(false)) while importing", () => {
  assert.equal(
    shouldAllowExternalImportDialogOpenChange({
      importing: true,
      loading: false,
      nextOpen: false
    }),
    false
  );
});

test("blocks the X close button (onOpenChange(false)) while scanning", () => {
  assert.equal(
    shouldAllowExternalImportDialogOpenChange({
      importing: false,
      loading: true,
      nextOpen: false
    }),
    false
  );
});

test("allows the X close button (onOpenChange(false)) when idle", () => {
  assert.equal(
    shouldAllowExternalImportDialogOpenChange({
      importing: false,
      loading: false,
      nextOpen: false
    }),
    true
  );
});

test("allows the X close button once importing finishes and a result is shown", () => {
  // handleImport's finally block clears `importing` before/along with
  // setResult, so by the time the result screen is visible the wizard is
  // idle again and dismissal must not be trapped.
  assert.equal(
    shouldAllowExternalImportDialogOpenChange({
      importing: false,
      loading: false,
      nextOpen: false
    }),
    true
  );
});

test("never blocks opening the dialog, even if somehow called while busy", () => {
  assert.equal(
    shouldAllowExternalImportDialogOpenChange({
      importing: true,
      loading: true,
      nextOpen: true
    }),
    true
  );
});
