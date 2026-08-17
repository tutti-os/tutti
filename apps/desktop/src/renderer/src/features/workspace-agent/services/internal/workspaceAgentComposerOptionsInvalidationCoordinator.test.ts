import assert from "node:assert/strict";
import test from "node:test";
import type { TuttidEventStreamClient } from "@tutti-os/client-tuttid-ts";
import type { WorkspaceAgentSessionEngineHost } from "./workspaceAgentSessionEngineHost.ts";
import { WorkspaceAgentComposerOptionsInvalidationCoordinator } from "./workspaceAgentComposerOptionsInvalidationCoordinator.ts";

test("connector Lab visibility changes invalidate cached Composer Options", () => {
  const dispatched: unknown[] = [];
  const host = {
    engine: {
      dispatch(intent: unknown) {
        dispatched.push(intent);
      }
    }
  } as unknown as WorkspaceAgentSessionEngineHost;
  type PreferencesUpdatedEvent = {
    payload: { preferences: { featureFlags: Record<string, boolean> } };
  };
  const listeners = new Map<string, (event: PreferencesUpdatedEvent) => void>();
  const events = {
    subscribe(topic: string, listener: unknown) {
      listeners.set(
        topic,
        listener as (event: PreferencesUpdatedEvent) => void
      );
      return () => listeners.delete(topic);
    }
  } as unknown as TuttidEventStreamClient;
  const coordinator = new WorkspaceAgentComposerOptionsInvalidationCoordinator(
    () => [host]
  );
  const catalogInvalidations: unknown[] = [];
  coordinator.onConnectorCatalogInvalidated((event) => {
    catalogInvalidations.push(event);
  });
  coordinator.subscribe(events);

  const publishVisibility = (enabled: boolean) => {
    listeners.get("preferences.desktop.updated")?.({
      payload: {
        preferences: { featureFlags: { "lab.connectors": enabled } }
      }
    });
  };

  publishVisibility(false);
  publishVisibility(false);
  publishVisibility(true);

  assert.deepEqual(dispatched, [
    { sections: ["connectors"], type: "composerOptions/invalidated" },
    { sections: ["connectors"], type: "composerOptions/invalidated" }
  ]);
  assert.deepEqual(catalogInvalidations, [{ revision: 1 }, { revision: 2 }]);
});
