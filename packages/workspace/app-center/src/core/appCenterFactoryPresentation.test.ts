import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveFactoryPublishActionKey,
  resolveFactoryStatusLabelKey
} from "./appCenterFactoryPresentation.ts";

test("local-save presentation removes publish semantics", () => {
  assert.equal(
    resolveFactoryPublishActionKey("local-save", false),
    "factory.actions.saveLocal"
  );
  assert.equal(
    resolveFactoryPublishActionKey("local-save", true),
    "actions.saveAppUpdate"
  );
  assert.equal(
    resolveFactoryStatusLabelKey(
      "local-save",
      "published",
      "factory.status.published"
    ),
    "factory.status.saved"
  );
});

test("default presentation preserves existing publish semantics", () => {
  assert.equal(
    resolveFactoryPublishActionKey("default", true),
    "actions.publishAppUpdate"
  );
  assert.equal(
    resolveFactoryStatusLabelKey(
      "default",
      "published",
      "factory.status.published"
    ),
    "factory.status.published"
  );
});
