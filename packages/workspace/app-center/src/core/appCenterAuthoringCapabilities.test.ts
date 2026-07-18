import assert from "node:assert/strict";
import test from "node:test";
import type { AppCenterHostActions } from "../ui/AppCard.tsx";
import { resolveAppCenterAuthoringCapabilities } from "./appCenterAuthoringCapabilities.ts";

const allActions: AppCenterHostActions = {
  createFactoryJob: () => {},
  importApp: () => {},
  loadLocalApp: () => {}
};

for (let mask = 0; mask < 8; mask += 1) {
  test(`resolves authoring capability combination ${mask}`, () => {
    const createApp = (mask & 1) !== 0;
    const importArchive = (mask & 2) !== 0;
    const loadUnpacked = (mask & 4) !== 0;

    assert.deepEqual(
      resolveAppCenterAuthoringCapabilities(
        { createApp, importArchive, loadUnpacked },
        allActions
      ),
      { createApp, importArchive, loadUnpacked }
    );
  });
}

test("defaults missing authoring capabilities to disabled", () => {
  assert.deepEqual(
    resolveAppCenterAuthoringCapabilities(undefined, allActions),
    {
      createApp: false,
      importArchive: false,
      loadUnpacked: false
    }
  );
});

test("fails closed when a declared capability has no matching action", () => {
  assert.deepEqual(
    resolveAppCenterAuthoringCapabilities(
      { createApp: true, importArchive: true, loadUnpacked: true },
      {}
    ),
    { createApp: false, importArchive: false, loadUnpacked: false }
  );
});
