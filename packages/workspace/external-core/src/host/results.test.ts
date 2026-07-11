import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeTuttiExternalHostEventPayload,
  normalizeTuttiExternalRequestResult
} from "./results.ts";

test("rejects malformed optional at-query metadata", () => {
  const base = {
    insert: { kind: "text", text: "hello" },
    itemId: "item-1",
    label: "Item",
    providerId: "file"
  };
  for (const result of [
    { ...base, subtitle: 42 },
    { ...base, thumbnailUrl: 42 },
    {
      ...base,
      insert: {
        kind: "mention",
        mention: { entityId: "id", label: "label", scope: { roomId: 42 } }
      }
    },
    {
      ...base,
      insert: {
        kind: "mention",
        mention: {
          entityId: "id",
          label: "label",
          presentation: { status: 42 }
        }
      }
    }
  ]) {
    assert.throws(
      () => normalizeTuttiExternalRequestResult("at.query", [result]),
      /at\.query host result/
    );
  }
});

test("rejects malformed optional file-reference metadata", () => {
  const base = { kind: "file", path: "/workspace/file.txt" };
  for (const reference of [
    { ...base, createdTimeMs: "now" },
    { ...base, displayName: 42 },
    { ...base, hostPath: 42 },
    { ...base, mtimeMs: Number.NaN },
    { ...base, sizeBytes: "large" },
    { ...base, sourceId: 42 }
  ]) {
    assert.throws(
      () => normalizeTuttiExternalRequestResult("files.select", [reference]),
      /files\.select host result/
    );
  }
});

test("rejects malformed optional managed-permission metadata", () => {
  for (const result of [
    { code: "grant", contextToken: 42 },
    { code: "grant", expiresAt: 42 },
    {
      code: "grant",
      models: [{ id: "model", name: 42, provider: "openai" }]
    }
  ]) {
    assert.throws(
      () => normalizeTuttiExternalRequestResult("permissions.request", result),
      /permissions\.request host/
    );
  }
});

test("rejects malformed optional user-project metadata", () => {
  const base = { id: "project", label: "Project", path: "/project" };
  for (const project of [
    { ...base, createdAtUnixMs: "now" },
    { ...base, lastUsedAtUnixMs: Number.NaN },
    { ...base, sectionKey: 42 },
    { ...base, updatedAtUnixMs: "now" }
  ]) {
    assert.throws(
      () =>
        normalizeTuttiExternalRequestResult("userProjects.list", {
          projects: [project]
        }),
      /userProjects host project/
    );
  }
});

test("rejects non-undefined results for void operations", () => {
  for (const operation of [
    "activity.reportActive",
    "files.open",
    "settings.open",
    "workspace.openFeature",
    "references.open",
    "userProjects.rememberDefaultSelection"
  ] as const) {
    assert.throws(
      () => normalizeTuttiExternalRequestResult(operation, { ok: true }),
      /host result must be undefined/
    );
  }
});

test("normalizes safe launch routes and rejects origin escapes", () => {
  assert.deepEqual(
    normalizeTuttiExternalHostEventPayload("workspace.launchIntent", {
      kind: "open-route",
      route: " /canvas/1 "
    }),
    { kind: "open-route", route: "/canvas/1" }
  );
  for (const route of [
    "//evil.example/path",
    "/\\evil.example/path",
    "/https://evil.example/path"
  ]) {
    assert.throws(
      () =>
        normalizeTuttiExternalHostEventPayload("workspace.launchIntent", {
          kind: "open-route",
          route
        }),
      /origin-root path/
    );
  }
});
