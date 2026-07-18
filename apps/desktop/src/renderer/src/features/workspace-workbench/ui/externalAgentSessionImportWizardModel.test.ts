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
  isExternalImportArchiveMode,
  isExternalImportWizardBusy,
  shouldAllowExternalImportDialogOpenChange
} from "./externalAgentSessionImportWizardModel.ts";

test("archive source keeps the same path and kind for scan and disables project registration", () => {
  assert.equal(isExternalImportArchiveMode(" /tmp/claude-export.zip "), true);
  const source = externalImportScanSource({
    archiveKind: "claude",
    archivePath: " /tmp/claude-export.zip ",
    days: -1,
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
    days: -1,
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

test("local source keeps providers and the project registration preference", () => {
  assert.equal(isExternalImportArchiveMode(null), false);
  assert.deepEqual(
    externalImportScanRequest(
      externalImportScanSource({
        archiveKind: "claude",
        archivePath: null,
        days: 30,
        providers: ["codex"]
      })
    ),
    { days: 30, providers: ["codex"] }
  );
  assert.deepEqual(externalImportRequestSource(null, null, false), {
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
    archiveKind: "claude",
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
        archiveKind: "claude",
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
        archiveKind: "chatgpt",
        archivePath: "/tmp/claude-export-a.zip",
        days: -1,
        providers: ["codex", "claude-code"]
      })
    ),
    null,
    "same path but a different archive kind must not reuse the scan"
  );
  assert.equal(
    externalImportUsableScan(
      state,
      externalImportScanSource({
        archiveKind: "claude",
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
    archiveKind: "claude",
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
