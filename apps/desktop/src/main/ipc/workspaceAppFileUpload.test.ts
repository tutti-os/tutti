import assert from "node:assert/strict";
import test from "node:test";
import {
  createWorkspaceAppUploadContentPutRequest,
  normalizeWorkspaceAppUploadCancelInput,
  normalizeWorkspaceAppUploadCompleteInput,
  normalizeWorkspaceAppUploadPrepareInput
} from "./workspaceAppFileUpload.ts";

test("workspace app upload prepare input preserves validated upload metadata", () => {
  assert.deepEqual(
    normalizeWorkspaceAppUploadPrepareInput({
      mimeType: "text/plain",
      name: "notes.txt",
      purpose: "app-asset",
      sizeBytes: 42
    }),
    {
      mimeType: "text/plain",
      name: "notes.txt",
      purpose: "app-asset",
      sizeBytes: 42
    }
  );
});

test("workspace app upload input rejects missing required fields", () => {
  assert.throws(
    () =>
      normalizeWorkspaceAppUploadPrepareInput({
        mimeType: "text/plain",
        name: "notes.txt",
        sizeBytes: -1
      }),
    /sizeBytes must be a non-negative number/u
  );
  assert.throws(
    () => normalizeWorkspaceAppUploadCompleteInput({ uploadId: " " }),
    /uploadId is required/u
  );
  assert.deepEqual(
    normalizeWorkspaceAppUploadCancelInput({ uploadId: " u1 " }),
    {
      uploadId: "u1"
    }
  );
});

test("workspace app upload content request uses app-scoped bearer token", () => {
  const request = createWorkspaceAppUploadContentPutRequest(
    {
      accessToken: " access-token ",
      boundAddr: "127.0.0.1:49217",
      listenerInfoPath: "",
      pidPath: "",
      requestedAddr: "127.0.0.1:0"
    },
    {
      appID: "app/beta",
      ownerWindow: {} as never,
      workspaceID: "workspace 1"
    },
    "upload/id",
    "2026-07-22T00:00:00Z"
  );

  assert.equal(request.expiresAt, "2026-07-22T00:00:00Z");
  assert.equal(request.method, "PUT");
  assert.equal(request.uploadId, "upload/id");
  assert.equal(
    request.url,
    "http://127.0.0.1:49217/v1/workspaces/workspace%201/apps/app%2Fbeta/uploads/upload%2Fid/content"
  );
  const authorization = request.headers.Authorization;
  assert.ok(authorization);
  assert.match(authorization, /^Bearer tutti-app-v1\.[A-Za-z0-9_-]+$/u);
  assert.equal(request.headers["Content-Type"], "application/octet-stream");
});
