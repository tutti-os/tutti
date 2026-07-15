import assert from "node:assert/strict";
import test from "node:test";
import { WorkspaceScopedPresenterRegistry } from "./workspaceScopedPresenterRegistry.ts";

test("workspace-scoped presenter registry isolates normalized workspace registrations", () => {
  const registry = new WorkspaceScopedPresenterRegistry<{ id: string }>();
  const first = { id: "first" };
  const second = { id: "second" };

  registry.register(" workspace-1 ", first);
  registry.register("workspace-2", second);

  assert.equal(registry.get("workspace-1"), first);
  assert.equal(registry.get(" workspace-2 "), second);
  assert.equal(registry.get("workspace-3"), undefined);
});

test("workspace-scoped presenter registry ignores empty workspace registrations", () => {
  const registry = new WorkspaceScopedPresenterRegistry<{ id: string }>();
  const dispose = registry.register(" ", { id: "ignored" });

  dispose();

  assert.equal(registry.get(" "), undefined);
});

test("workspace-scoped presenter registry keeps a replacement after stale disposal", () => {
  const registry = new WorkspaceScopedPresenterRegistry<{ id: string }>();
  const disposeFirst = registry.register("workspace-1", { id: "first" });
  const replacement = { id: "replacement" };
  registry.register("workspace-1", replacement);

  disposeFirst();

  assert.equal(registry.get("workspace-1"), replacement);
});

test("workspace-scoped presenter registry distinguishes repeated registrations", () => {
  const registry = new WorkspaceScopedPresenterRegistry<{ id: string }>();
  const presenter = { id: "shared" };
  const disposeFirst = registry.register("workspace-1", presenter);
  registry.register("workspace-1", presenter);

  disposeFirst();

  assert.equal(registry.get("workspace-1"), presenter);
});

test("workspace-scoped presenter registry removes the active registration", () => {
  const registry = new WorkspaceScopedPresenterRegistry<{ id: string }>();
  const dispose = registry.register("workspace-1", { id: "presenter" });

  dispose();

  assert.equal(registry.get("workspace-1"), undefined);
});
