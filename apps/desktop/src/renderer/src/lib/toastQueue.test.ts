import assert from "node:assert/strict";
import test from "node:test";
import { enqueueDesktopToast, type DesktopToastItem } from "./toastQueue.ts";

const missingFileToast: DesktopToastItem = {
  description: "The file could not be found",
  id: "toast-1",
  title: "File no longer exists",
  tone: "destructive"
};

test("desktop toast queue keeps one visible copy of an identical toast", () => {
  const current = [missingFileToast];

  const next = enqueueDesktopToast(
    current,
    { ...missingFileToast, id: "toast-2" },
    4
  );

  assert.strictEqual(next, current);
});

test("desktop toast queue preserves notifications with different content or tone", () => {
  const current = [missingFileToast];
  const differentDescription = enqueueDesktopToast(
    current,
    {
      ...missingFileToast,
      description: "A different file could not be found",
      id: "toast-2"
    },
    4
  );
  const differentTone = enqueueDesktopToast(
    differentDescription,
    { ...missingFileToast, id: "toast-3", tone: "default" },
    4
  );

  assert.deepEqual(
    differentTone.map((toast) => toast.id),
    ["toast-3", "toast-2", "toast-1"]
  );
});

test("desktop toast queue still enforces its visible toast limit", () => {
  const current = Array.from({ length: 4 }, (_, index) => ({
    id: `toast-${index + 1}`,
    title: `Toast ${index + 1}`,
    tone: "default" as const
  }));

  const next = enqueueDesktopToast(
    current,
    { id: "toast-5", title: "Toast 5", tone: "default" },
    4
  );

  assert.deepEqual(
    next.map((toast) => toast.id),
    ["toast-5", "toast-1", "toast-2", "toast-3"]
  );
});
