import assert from "node:assert/strict";
import test from "node:test";
import { createDisabledAppUpdateService } from "./disabledAppUpdateService.ts";

test("disabled app update service never exposes update actions", async () => {
  const service = createDisabledAppUpdateService();
  const emittedStatuses: string[] = [];
  service.onStateChanged((state) => {
    emittedStatuses.push(state.status);
  });

  const configuredState = await service.configure({
    channel: "rc",
    policy: "auto"
  });
  const checkedState = await service.checkForUpdates();
  const downloadedState = await service.downloadUpdate();
  await service.installUpdate();

  assert.equal(configuredState.status, "unsupported");
  assert.equal(configuredState.policy, "auto");
  assert.equal(configuredState.channel, "rc");
  assert.equal(checkedState, configuredState);
  assert.equal(downloadedState, configuredState);
  assert.deepEqual(emittedStatuses, ["unsupported"]);
  service.dispose();
});
