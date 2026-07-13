import assert from "node:assert/strict";
import test from "node:test";
import { createStandaloneWorkbenchExternalStateRevisionStore } from "./standaloneWorkbenchExternalState.ts";

test("standalone workbench external state exposes a cached primitive revision", () => {
  let publish: () => void = () => undefined;
  let disposed = false;
  const store = createStandaloneWorkbenchExternalStateRevisionStore({
    subscribe(listener) {
      publish = listener;
      return () => {
        disposed = true;
      };
    }
  });
  const observed: number[] = [];
  const unsubscribe = store.subscribe(() => {
    observed.push(store.getSnapshot());
  });

  assert.equal(store.getSnapshot(), store.getSnapshot());
  assert.equal(store.getSnapshot(), 0);
  publish();
  publish();
  assert.deepEqual(observed, [1, 2]);
  assert.equal(store.getSnapshot(), 2);

  unsubscribe();
  assert.equal(disposed, true);
});

test("standalone workbench external state is inert without a subscriber", () => {
  const store = createStandaloneWorkbenchExternalStateRevisionStore(undefined);
  const unsubscribe = store.subscribe(() => {
    assert.fail("listener should not run");
  });

  assert.equal(store.getSnapshot(), 0);
  unsubscribe();
});
