import assert from "node:assert/strict";
import test from "node:test";
import { createBrowserNodeWorkbenchCloseRequests } from "./browserNodeCloseRequests.ts";

test("final Browser tab closes the owning Workbench window once", () => {
  let workbenchCloseCount = 0;
  const requests = createBrowserNodeWorkbenchCloseRequests({
    close: () => {
      workbenchCloseCount += 1;
    }
  });

  requests.onFinalTabCloseRequest();

  assert.equal(workbenchCloseCount, 1);
  assert.deepEqual(Object.keys(requests), ["onFinalTabCloseRequest"]);
});
