import assert from "node:assert/strict";
import test from "node:test";

import {
  connectorCardActionStartsInstallation,
  connectorCardBusyActionLabelKey
} from "./connectorCardAction.ts";

test("routes connector install and update actions directly to installation", () => {
  assert.equal(connectorCardActionStartsInstallation("install"), true);
  assert.equal(connectorCardActionStartsInstallation("update"), true);
  assert.equal(connectorCardActionStartsInstallation("authorize"), false);
  assert.equal(connectorCardActionStartsInstallation("manage"), false);
});

test("labels an active connector update as updating", () => {
  assert.equal(
    connectorCardBusyActionLabelKey({
      authorizationState: "failed",
      installationState: "installed",
      mutationPhase: null,
      operationStage: null,
      status: "updating"
    }),
    "actionUpdating"
  );
});

test("labels a settling authorization from the local mutation phase", () => {
  assert.equal(
    connectorCardBusyActionLabelKey({
      authorizationState: "connected",
      installationState: "installed",
      mutationPhase: "authorizing",
      operationStage: "completed",
      status: "connected"
    }),
    "actionWaitingAuthorization"
  );
});
