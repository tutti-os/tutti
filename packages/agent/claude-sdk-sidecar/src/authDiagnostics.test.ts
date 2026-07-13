import assert from "node:assert/strict";
import test from "node:test";
import {
  claudeAuthRefreshDiagnosticsEnabled,
  sanitizeClaudeAuthDiagnosticPayload
} from "./authDiagnostics.ts";

test("auth refresh diagnostics require an explicit truthy override", () => {
  const previous = process.env.TUTTI_CLAUDE_AUTH_REFRESH_DEBUG;
  try {
    delete process.env.TUTTI_CLAUDE_AUTH_REFRESH_DEBUG;
    assert.equal(claudeAuthRefreshDiagnosticsEnabled(), false);
    process.env.TUTTI_CLAUDE_AUTH_REFRESH_DEBUG = "false";
    assert.equal(claudeAuthRefreshDiagnosticsEnabled(), false);
    process.env.TUTTI_CLAUDE_AUTH_REFRESH_DEBUG = "1";
    assert.equal(claudeAuthRefreshDiagnosticsEnabled(), true);
  } finally {
    if (previous === undefined) {
      delete process.env.TUTTI_CLAUDE_AUTH_REFRESH_DEBUG;
    } else {
      process.env.TUTTI_CLAUDE_AUTH_REFRESH_DEBUG = previous;
    }
  }
});

test("auth diagnostic sanitizer removes paths, accounts, and secret-bearing errors", () => {
  const sanitized = sanitizeClaudeAuthDiagnosticPayload({
    stage: "query_initialization.failed",
    providerSessionId: "session-1",
    cwd: "/Users/alice/private-project",
    credentials: {
      configDir: "/Users/alice/.claude",
      effectiveSource: "keychain",
      keychain: {
        account: "alice",
        serviceName: "Claude Code-credentials",
        accessTokenFp: "1234abcd"
      },
      plaintext: {
        path: "/Users/alice/.claude/.credentials.json"
      }
    },
    error: {
      name: "Error",
      message: "failed to read /Users/alice/.claude",
      stack: "Error: secret-bearing stack",
      cause: { refreshToken: "refresh-secret" },
      code: "ENOENT"
    }
  });

  assert.deepEqual(sanitized, {
    stage: "query_initialization.failed",
    providerSessionId: "session-1",
    credentials: {
      effectiveSource: "keychain",
      keychain: { accessTokenFp: "1234abcd" },
      plaintext: {}
    },
    error: { name: "Error", code: "ENOENT" }
  });
  const serialized = JSON.stringify(sanitized);
  assert.doesNotMatch(serialized, /alice|private-project|refresh-secret/);
});
