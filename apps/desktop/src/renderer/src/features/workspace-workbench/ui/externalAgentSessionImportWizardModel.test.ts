import assert from "node:assert/strict";
import test from "node:test";
import {
  externalImportGroupsFromScan,
  externalImportRequestSource,
  externalImportScanRequest,
  externalImportScanSource,
  externalImportScanStateReducer,
  externalImportSelectionProjects,
  externalImportUsableScan,
  filterExternalImportGroups,
  isExternalImportArchiveMode
} from "./externalAgentSessionImportWizardModel.ts";

test("archive source keeps the same path for scan and disables project registration", () => {
  assert.equal(isExternalImportArchiveMode(" /tmp/claude-export.zip "), true);
  const source = externalImportScanSource({
    archivePath: " /tmp/claude-export.zip ",
    days: -1,
    providers: ["codex", "claude-code"]
  });
  assert.deepEqual(externalImportScanRequest(source), {
    archivePath: "/tmp/claude-export.zip",
    days: -1
  });
  assert.deepEqual(
    externalImportRequestSource(" /tmp/claude-export.zip ", true),
    {
      archivePath: "/tmp/claude-export.zip",
      registerUserProjects: false
    }
  );
});

test("local source keeps providers and the project registration preference", () => {
  assert.equal(isExternalImportArchiveMode(null), false);
  assert.deepEqual(
    externalImportScanRequest(
      externalImportScanSource({
        archivePath: null,
        days: 30,
        providers: ["codex"]
      })
    ),
    { days: 30, providers: ["codex"] }
  );
  assert.deepEqual(externalImportRequestSource(null, false), {
    registerUserProjects: false
  });
});

test("completed scan is usable only for its exact source identity", () => {
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
    archivePath: "/tmp/claude-export-a.zip",
    days: -1,
    providers: ["codex", "claude-code"]
  });
  const state = externalImportScanStateReducer(null, {
    type: "scan-succeeded",
    response,
    source
  });

  assert.equal(externalImportUsableScan(state, source), response);
  assert.equal(
    externalImportUsableScan(
      state,
      externalImportScanSource({
        archivePath: "/tmp/claude-export-b.zip",
        days: -1,
        providers: ["codex", "claude-code"]
      })
    ),
    null
  );
  assert.equal(
    externalImportUsableScan(
      state,
      externalImportScanSource({
        archivePath: null,
        days: -1,
        providers: ["codex", "claude-code"]
      })
    ),
    null
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
    archivePath: "/tmp/claude-export.zip",
    days: -1,
    providers: []
  });
  const completed = externalImportScanStateReducer(null, {
    type: "scan-succeeded",
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
