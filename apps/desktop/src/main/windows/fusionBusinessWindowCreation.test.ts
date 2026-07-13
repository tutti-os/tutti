import assert from "node:assert/strict";
import test from "node:test";
import { ensureFusionBusinessWindowCreation } from "./fusionBusinessWindowCreation.ts";

test("Fusion business window creation is single-flight per instance", async () => {
  const inFlight = new Map<string, Promise<{ id: string }>>();
  let resolveCreation!: (value: { id: string }) => void;
  let createCount = 0;
  const create = () => {
    createCount += 1;
    return new Promise<{ id: string }>((resolve) => {
      resolveCreation = resolve;
    });
  };

  const first = ensureFusionBusinessWindowCreation({
    create,
    inFlight,
    windowInstanceId: "window-1"
  });
  const second = ensureFusionBusinessWindowCreation({
    create,
    inFlight,
    windowInstanceId: "window-1"
  });

  assert.equal(first, second);
  assert.equal(createCount, 0);
  resolveCreation = await waitForResolver(() => resolveCreation);
  assert.equal(createCount, 1);
  resolveCreation({ id: "window-1" });
  assert.deepEqual(await Promise.all([first, second]), [
    { id: "window-1" },
    { id: "window-1" }
  ]);
  assert.equal(inFlight.size, 0);
});

test("Fusion business window creation can retry after failure", async () => {
  const inFlight = new Map<string, Promise<string>>();
  await assert.rejects(
    ensureFusionBusinessWindowCreation({
      create: async () => {
        throw new Error("load failed");
      },
      inFlight,
      windowInstanceId: "window-1"
    }),
    /load failed/u
  );

  assert.equal(inFlight.size, 0);
  assert.equal(
    await ensureFusionBusinessWindowCreation({
      create: async () => "ready",
      inFlight,
      windowInstanceId: "window-1"
    }),
    "ready"
  );
});

async function waitForResolver<T>(read: () => T | undefined): Promise<T> {
  for (let index = 0; index < 10; index += 1) {
    const value = read();
    if (value) {
      return value;
    }
    await Promise.resolve();
  }
  throw new Error("creation did not start");
}
