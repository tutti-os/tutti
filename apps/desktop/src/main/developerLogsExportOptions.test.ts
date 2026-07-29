import assert from "node:assert/strict";
import test from "node:test";
import {
  createDefaultDeveloperLogsExportFileName,
  normalizeDeveloperLogsExportInput,
  resolveDeveloperLogsTimeWindow
} from "./developerLogsExportOptions.ts";

test("developer log export options preserve supported combinations", () => {
  assert.deepEqual(
    normalizeDeveloperLogsExportInput({
      includeAgentSessions: false,
      scope: "recent-10-minutes"
    }),
    { includeAgentSessions: false, scope: "recent-10-minutes" }
  );
  assert.deepEqual(
    normalizeDeveloperLogsExportInput({
      includeAgentSessions: true,
      scope: "recent-3-days"
    }),
    { includeAgentSessions: true, scope: "recent-3-days" }
  );
});

test("developer log export options map legacy or invalid input to three days with sessions", () => {
  assert.deepEqual(normalizeDeveloperLogsExportInput({ scope: "all" }), {
    includeAgentSessions: true,
    scope: "recent-3-days"
  });
  assert.deepEqual(normalizeDeveloperLogsExportInput(null), {
    includeAgentSessions: true,
    scope: "recent-3-days"
  });
});

test("developer log export options resolve range and descriptive file name", () => {
  const exportedAt = new Date("2026-07-20T12:00:00.000Z");
  assert.deepEqual(
    resolveDeveloperLogsTimeWindow("recent-3-days", exportedAt),
    {
      endTimeUnixMs: exportedAt.getTime(),
      startTimeUnixMs: Date.parse("2026-07-17T12:00:00.000Z")
    }
  );
  assert.match(
    createDefaultDeveloperLogsExportFileName({
      exportedAt,
      includeAgentSessions: true,
      scope: "recent-3-days"
    }),
    /^tutti-logs-last-3-days-with-sessions-\d{8}-\d{6}\.zip$/
  );
});
