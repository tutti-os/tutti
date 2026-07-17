import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeTuttiExternalAtQueryInput,
  normalizeTuttiExternalAtResolveInput,
  normalizeTuttiExternalAtInvalidation,
  normalizeTuttiExternalBrowserOpenUrlInput,
  normalizeTuttiExternalFileOpenInput,
  normalizeTuttiExternalFileSelectInput,
  normalizeTuttiExternalFileUploadInput,
  normalizeTuttiExternalLogInput,
  normalizeTuttiExternalPdfPrintHtmlInput,
  normalizeTuttiExternalPermissionRequestInput,
  normalizeTuttiExternalReferenceOpenInput,
  normalizeTuttiExternalSettingsOpenInput,
  normalizeTuttiExternalUserProjectCreateInput,
  normalizeTuttiExternalUserProjectMoveInput,
  normalizeTuttiExternalUserProjectPathInput,
  normalizeTuttiExternalUserProjectRememberDefaultSelectionInput,
  normalizeTuttiExternalUserProjectSelectionPreparationInput,
  normalizeTuttiExternalWorkspaceOpenFeatureInput,
  tuttiExternalAtDefaultMaxResults,
  tuttiExternalAtMaxResultsLimit,
  tuttiExternalAtProviderIds,
  tuttiExternalWorkspaceAgentProviders,
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

test("normalizes exact at resolve identity and invalidation", () => {
  assert.deepEqual(
    normalizeTuttiExternalAtResolveInput({
      providerId: "workspace-app",
      entityId: " canvas ",
      scope: { workspaceId: "workspace-1" }
    }),
    {
      providerId: "workspace-app",
      entityId: "canvas",
      scope: { workspaceId: "workspace-1" }
    }
  );
  assert.deepEqual(
    normalizeTuttiExternalAtInvalidation({
      providerIds: ["workspace-app", "workspace-app"],
      entityIds: [" canvas ", "canvas"],
      revision: 2
    }),
    {
      providerIds: ["workspace-app"],
      entityIds: ["canvas"],
      revision: 2
    }
  );
});

test("rejects malformed at resolve identity and invalidation", () => {
  assert.throws(
    () =>
      normalizeTuttiExternalAtResolveInput({
        providerId: "unknown",
        entityId: "canvas"
      }),
    /providerId is unsupported/
  );
  assert.throws(
    () =>
      normalizeTuttiExternalAtResolveInput({
        providerId: "workspace-app",
        entityId: "canvas",
        scope: { workspaceId: 1 }
      }),
    /scope must contain string values/
  );
  assert.throws(
    () => normalizeTuttiExternalAtInvalidation({ revision: Number.NaN }),
    /revision must be finite/
  );
});

test("keeps the default provider set explicit", () => {
  assert.deepEqual(tuttiExternalAtProviderIds, [
    "file",
    "workspace-issue",
    "workspace-app",
    "agent-target",
    "agent-session",
    "agent-generated-file"
  ]);
});

test("normalizes browser open URL input", () => {
  assert.deepEqual(
    normalizeTuttiExternalBrowserOpenUrlInput({
      url: " https://example.com/design "
    }),
    {
      url: "https://example.com/design"
    }
  );
});

test("rejects invalid browser open URL input", () => {
  assert.throws(
    () => normalizeTuttiExternalBrowserOpenUrlInput({ url: "" }),
    /browser\.openUrl url is required/
  );
  assert.throws(
    () =>
      normalizeTuttiExternalBrowserOpenUrlInput({ url: "file:///tmp/a.html" }),
    /browser\.openUrl protocol is unsupported/
  );
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

test("normalizes file upload input defaults", () => {
  assert.deepEqual(normalizeTuttiExternalFileUploadInput(undefined), {
    purpose: "app-asset"
  });
});

test("normalizes file upload input strings", () => {
  const controller = new AbortController();
  const onProgress = () => undefined;
  assert.deepEqual(
    normalizeTuttiExternalFileUploadInput({
      purpose: "app-asset",
      name: " Image.PNG ",
      mimeType: " image/png ",
      onProgress,
      signal: controller.signal
    }),
    {
      purpose: "app-asset",
      name: "Image.PNG",
      mimeType: "image/png",
      onProgress,
      signal: controller.signal
    }
  );
});

test("rejects invalid file upload input", () => {
  assert.throws(
    () => normalizeTuttiExternalFileUploadInput("bad"),
    /input must be an object/
  );
  assert.throws(
    () => normalizeTuttiExternalFileUploadInput({ purpose: "avatar" }),
    /purpose is unsupported/
  );
  assert.throws(
    () => normalizeTuttiExternalFileUploadInput({ name: 1 }),
    /name must be a string/
  );
  assert.throws(
    () => normalizeTuttiExternalFileUploadInput({ mimeType: 1 }),
    /mimeType must be a string/
  );
  assert.throws(
    () => normalizeTuttiExternalFileUploadInput({ onProgress: true }),
    /onProgress must be a function/
  );
  assert.throws(
    () => normalizeTuttiExternalFileUploadInput({ signal: {} }),
    /signal must be an AbortSignal/
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

test("normalizes PDF print HTML input", () => {
  assert.deepEqual(
    normalizeTuttiExternalPdfPrintHtmlInput({
      baseUrl: " http://127.0.0.1:8790/project/ ",
      html: " <h1>Doc</h1> ",
      margin: {
        bottom: "14mm",
        left: " 10mm ",
        right: "10mm",
        top: "12mm"
      },
      pageSize: { width: 13.333333, height: 7.5 },
      preferCSSPageSize: true,
      printBackground: false,
      title: " Report "
    }),
    {
      baseUrl: "http://127.0.0.1:8790/project/",
      html: "<h1>Doc</h1>",
      margin: {
        bottom: "14mm",
        left: "10mm",
        right: "10mm",
        top: "12mm"
      },
      pageSize: { width: 13.333333, height: 7.5 },
      preferCSSPageSize: true,
      printBackground: false,
      title: "Report"
    }
  );
});

test("rejects invalid PDF print HTML input", () => {
  assert.throws(
    () => normalizeTuttiExternalPdfPrintHtmlInput({ html: "" }),
    /html is required/
  );
  assert.throws(
    () =>
      normalizeTuttiExternalPdfPrintHtmlInput({
        baseUrl: "file:///tmp/doc.html",
        html: "<h1>Doc</h1>"
      }),
    /baseUrl protocol is unsupported/
  );
  assert.throws(
    () =>
      normalizeTuttiExternalPdfPrintHtmlInput({
        html: "<h1>Doc</h1>",
        margin: { top: "12pt" }
      }),
    /margin top unit is unsupported/
  );
  assert.throws(
    () =>
      normalizeTuttiExternalPdfPrintHtmlInput({
        html: "<h1>Doc</h1>",
        pageSize: { width: 13.333333, height: 0 }
      }),
    /pageSize height must be a positive number/
  );
});

test("normalizes workspace feature open input", () => {
  assert.deepEqual(
    normalizeTuttiExternalWorkspaceOpenFeatureInput({
      feature: "agent-manage",
      provider: " codex "
    }),
    {
      feature: "agent-manage",
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
  assert.throws(
    () =>
      normalizeTuttiExternalWorkspaceOpenFeatureInput({
        feature: "agent-chat",
        provider: "unknown-agent"
      }),
    /provider is unsupported/
  );
});

test("keeps the workspace agent provider set explicit", () => {
  assert.deepEqual(tuttiExternalWorkspaceAgentProviders, [
    "claude-code",
    "codex",
    "cursor",
    "nexight",
    "hermes",
    "openclaw"
  ]);
});

test("normalizes reference open input", () => {
  assert.deepEqual(
    normalizeTuttiExternalReferenceOpenInput({
      href: "mention://workspace-app/app-1?workspaceId=workspace-1"
    }),
    {
      href: "mention://workspace-app/app-1?workspaceId=workspace-1"
    }
  );
});

test("rejects invalid reference open input", () => {
  assert.throws(
    () =>
      normalizeTuttiExternalReferenceOpenInput({ href: "https://example.com" }),
    /mention URL/
  );
});

test("normalizes user project inputs", () => {
  assert.deepEqual(
    normalizeTuttiExternalUserProjectCreateInput({ name: " Project " }),
    {
      name: "Project"
    }
  );
  assert.deepEqual(
    normalizeTuttiExternalUserProjectPathInput({ path: " /repo " }, "use"),
    {
      path: "/repo"
    }
  );
  assert.deepEqual(
    normalizeTuttiExternalUserProjectMoveInput({
      beforeProjectId: " before ",
      projectId: " project "
    }),
    { beforeProjectId: "before", projectId: "project" }
  );
  assert.deepEqual(
    normalizeTuttiExternalUserProjectMoveInput({
      beforeProjectId: null,
      projectId: "project"
    }),
    { beforeProjectId: null, projectId: "project" }
  );
  assert.deepEqual(
    normalizeTuttiExternalUserProjectRememberDefaultSelectionInput({
      path: "   "
    }),
    {
      path: null
    }
  );
  assert.deepEqual(
    normalizeTuttiExternalUserProjectSelectionPreparationInput({
      projectLocked: true,
      selectedPath: " /repo "
    }),
    {
      projectLocked: true,
      selectedPath: "/repo"
    }
  );
});

test("rejects invalid user project inputs", () => {
  assert.throws(
    () => normalizeTuttiExternalUserProjectCreateInput({ name: "" }),
    /name is required/
  );
  assert.throws(
    () => normalizeTuttiExternalUserProjectPathInput({ path: "" }, "checkPath"),
    /path is required/
  );
  assert.throws(
    () => normalizeTuttiExternalUserProjectMoveInput({ projectId: "project" }),
    /beforeProjectId is required/
  );
  assert.throws(
    () =>
      normalizeTuttiExternalUserProjectMoveInput({
        beforeProjectId: "",
        projectId: "project"
      }),
    /beforeProjectId is required/
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
