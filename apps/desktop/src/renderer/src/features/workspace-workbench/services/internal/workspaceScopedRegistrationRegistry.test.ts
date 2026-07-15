import assert from "node:assert/strict";
import test from "node:test";
import { WorkspaceScopedRegistrationRegistry } from "./workspaceScopedRegistrationRegistry.ts";

test("workspace-scoped registration registry isolates normalized workspace registrations", () => {
  const registry = new WorkspaceScopedRegistrationRegistry<{ id: string }>();
  const first = { id: "first" };
  const second = { id: "second" };

  registry.register(" workspace-1 ", first);
  registry.register("workspace-2", second);

  assert.equal(registry.get("workspace-1"), first);
  assert.equal(registry.get(" workspace-2 "), second);
  assert.equal(registry.get("workspace-3"), undefined);
});

test("workspace-scoped registration registry ignores empty workspace registrations", () => {
  const registry = new WorkspaceScopedRegistrationRegistry<{ id: string }>();
  const dispose = registry.register(" ", { id: "ignored" });

  dispose();

  assert.equal(registry.get(" "), undefined);
});

test("workspace-scoped registration registry keeps a replacement after stale disposal", () => {
  const registry = new WorkspaceScopedRegistrationRegistry<{ id: string }>();
  const disposeFirst = registry.register("workspace-1", { id: "first" });
  const replacement = { id: "replacement" };
  registry.register("workspace-1", replacement);

  disposeFirst();

  assert.equal(registry.get("workspace-1"), replacement);
});

test("workspace-scoped registration registry distinguishes repeated registrations", () => {
  const registry = new WorkspaceScopedRegistrationRegistry<{ id: string }>();
  const value = { id: "shared" };
  const disposeFirst = registry.register("workspace-1", value);
  registry.register("workspace-1", value);

  disposeFirst();

  assert.equal(registry.get("workspace-1"), value);
});

test("workspace-scoped registration registry removes the active registration", () => {
  const registry = new WorkspaceScopedRegistrationRegistry<{ id: string }>();
  const dispose = registry.register("workspace-1", { id: "value" });

  dispose();

  assert.equal(registry.get("workspace-1"), undefined);
});
