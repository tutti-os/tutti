import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeTuttiExternalAtQueryInput,
  normalizeTuttiExternalFileOpenInput,
  normalizeTuttiExternalFileSelectInput,
  normalizeTuttiExternalLogInput,
  normalizeTuttiExternalPermissionRequestInput,
  normalizeTuttiExternalSettingsOpenInput,
  normalizeTuttiExternalWorkspaceOpenFeatureInput,
  tuttiExternalAtDefaultMaxResults,
  tuttiExternalAtMaxResultsLimit,
  tuttiExternalAtProviderIds,
  tuttiExternalManagedAiModelProviderIds
} from "./index.ts";

test("normalizes at query defaults", () => {
  assert.deepEqual(normalizeTuttiExternalAtQueryInput({ keyword: "readme" }), {
    keyword: "readme",
    maxResults: tuttiExternalAtDefaultMaxResults,
    providers: undefined
  });
});

test("caps at query max results and deduplicates providers", () => {
  assert.deepEqual(
    normalizeTuttiExternalAtQueryInput({
      keyword: "",
      maxResults: tuttiExternalAtMaxResultsLimit + 10,
      providers: ["file", "file", "agent-session"]
    }),
    {
      keyword: "",
      maxResults: tuttiExternalAtMaxResultsLimit,
      providers: ["file", "agent-session"]
    }
  );
});

test("rejects unsupported at providers", () => {
  assert.throws(
    () =>
      normalizeTuttiExternalAtQueryInput({
        keyword: "readme",
        providers: ["file", "not-supported"]
      }),
    /unsupported provider/
  );
});

test("keeps the default provider set explicit", () => {
  assert.deepEqual(tuttiExternalAtProviderIds, [
    "file",
    "workspace-issue",
    "workspace-app",
    "agent-session",
    "agent-generated-file"
  ]);
});

test("normalizes file select input", () => {
  assert.deepEqual(normalizeTuttiExternalFileSelectInput(undefined), {});
  assert.deepEqual(normalizeTuttiExternalFileSelectInput({ multiple: true }), {
    multiple: true
  });
  assert.deepEqual(normalizeTuttiExternalFileSelectInput({ multiple: false }), {
    multiple: false
  });
});

test("normalizes file open input", () => {
  assert.deepEqual(
    normalizeTuttiExternalFileOpenInput({
      mode: "auto",
      mtimeMs: 123,
      name: " Report.md ",
      path: " docs/report.md ",
      sizeBytes: null
    }),
    {
      mode: "auto",
      mtimeMs: 123,
      name: "Report.md",
      path: "docs/report.md",
      sizeBytes: null
    }
  );
});

test("rejects invalid file open input", () => {
  assert.throws(
    () => normalizeTuttiExternalFileOpenInput({ path: "" }),
    /path is required/
  );
  assert.throws(
    () => normalizeTuttiExternalFileOpenInput({ path: "README.md", mode: "x" }),
    /mode is unsupported/
  );
});

test("normalizes managed AI model permission requests", () => {
  assert.deepEqual(
    normalizeTuttiExternalPermissionRequestInput({
      nonce: " nonce-1 ",
      permission: "managed-ai-models",
      providers: ["openai", "openai", "anthropic"],
      scopes: [" model:invoke ", "model:invoke"],
      state: " state-1 "
    }),
    {
      nonce: "nonce-1",
      permission: "managed-ai-models",
      providers: ["openai", "anthropic"],
      scopes: ["model:invoke"],
      state: "state-1"
    }
  );
});

test("rejects invalid managed AI model permission requests", () => {
  assert.throws(
    () =>
      normalizeTuttiExternalPermissionRequestInput({
        nonce: "nonce-1",
        permission: "managed-credentials",
        scopes: ["model:invoke"],
        state: "state-1"
      }),
    /permission is unsupported/
  );
  assert.throws(
    () =>
      normalizeTuttiExternalPermissionRequestInput({
        nonce: "nonce-1",
        permission: "managed-ai-models",
        scopes: [],
        state: "state-1"
      }),
    /scopes must not be empty/
  );
  assert.throws(
    () =>
      normalizeTuttiExternalPermissionRequestInput({
        nonce: "nonce-1",
        permission: "managed-ai-models",
        providers: ["not-supported"],
        scopes: ["model:invoke"],
        state: "state-1"
      }),
    /provider is unsupported/
  );
});

test("normalizes settings open input", () => {
  assert.deepEqual(normalizeTuttiExternalSettingsOpenInput(undefined), {});
  assert.deepEqual(
    normalizeTuttiExternalSettingsOpenInput({
      provider: "openai",
      tab: "models"
    }),
    {
      provider: "openai",
      tab: "models"
    }
  );
});

test("rejects invalid settings open input", () => {
  assert.throws(
    () => normalizeTuttiExternalSettingsOpenInput({ tab: "credentials" }),
    /tab is unsupported/
  );
  assert.throws(
    () => normalizeTuttiExternalSettingsOpenInput({ provider: "codex" }),
    /provider is unsupported/
  );
});

test("normalizes workspace feature open input", () => {
  assert.deepEqual(
    normalizeTuttiExternalWorkspaceOpenFeatureInput({
      feature: "message-center",
      provider: " codex "
    }),
    {
      feature: "message-center",
      provider: "codex"
    }
  );
});

test("rejects invalid workspace feature open input", () => {
  assert.throws(
    () => normalizeTuttiExternalWorkspaceOpenFeatureInput(null),
    /input must be an object/
  );
  assert.throws(
    () =>
      normalizeTuttiExternalWorkspaceOpenFeatureInput({
        feature: "not-supported"
      }),
    /feature is unsupported/
  );
});

test("keeps the managed AI model provider set explicit", () => {
  assert.deepEqual(tuttiExternalManagedAiModelProviderIds, [
    "agnes",
    "openai",
    "anthropic"
  ]);
});

test("normalizes external log input defaults", () => {
  assert.deepEqual(normalizeTuttiExternalLogInput({ event: "page.loaded" }), {
    event: "page.loaded"
  });
});

test("normalizes external log input with level and details", () => {
  assert.deepEqual(
    normalizeTuttiExternalLogInput({
      event: " request.failed ",
      level: "warn",
      details: {
        route: "/home",
        retryCount: 2
      }
    }),
    {
      event: "request.failed",
      level: "warn",
      details: {
        route: "/home",
        retryCount: 2
      }
    }
  );
});

test("truncates long external log detail strings", () => {
  const longValue = "x".repeat(8_500);
  const normalized = normalizeTuttiExternalLogInput({
    event: "payload.large",
    details: {
      message: longValue
    }
  });

  assert.equal(normalized.details?.message, `${"x".repeat(8_000)}...`);
});

test("rejects invalid external log input", () => {
  assert.throws(
    () => normalizeTuttiExternalLogInput(null),
    /input must be an object/
  );
  assert.throws(
    () => normalizeTuttiExternalLogInput({ event: "" }),
    /event is required/
  );
  assert.throws(
    () =>
      normalizeTuttiExternalLogInput({
        event: "page.loaded",
        level: "trace"
      }),
    /level is unsupported/
  );
  assert.throws(
    () =>
      normalizeTuttiExternalLogInput({
        event: "page.loaded",
        details: "invalid"
      }),
    /details must be an object/
  );
});
