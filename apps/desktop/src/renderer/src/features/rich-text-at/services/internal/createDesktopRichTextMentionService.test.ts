import assert from "node:assert/strict";
import test from "node:test";
import type { RichTextTriggerProvider } from "@tutti-os/ui-rich-text/types";
import { createDesktopRichTextMentionService } from "./createDesktopRichTextMentionService.ts";

test("desktop mention service shares one workspace-scoped resolver", async () => {
  let resolveCalls = 0;
  const provider: RichTextTriggerProvider = {
    id: "workspace-app",
    trigger: "@",
    query: () => [],
    getItemKey: () => "",
    getItemLabel: () => "",
    toInsertResult: () => ({ kind: "text", text: "" }),
    resolveMention: async () => {
      resolveCalls += 1;
      await Promise.resolve();
      return { presentation: { iconUrl: "tutti://app-icon/canvas" } };
    }
  };
  const requests: unknown[] = [];
  const service = createDesktopRichTextMentionService({
    richTextAtService: {
      _serviceBrand: undefined,
      getProviders(input) {
        requests.push(input);
        return [provider];
      }
    },
    workspaceId: "workspace-1"
  });
  const identity = {
    providerId: "workspace-app",
    entityId: "canvas",
    label: "Canvas",
    scope: { workspaceId: "workspace-1" }
  };

  const snapshots = await Promise.all([
    service.resolve(identity),
    service.resolve(identity),
    service.resolve(identity)
  ]);

  assert.equal(resolveCalls, 1);
  assert.equal(
    snapshots.every((snapshot) => snapshot.state === "ready"),
    true
  );
  assert.deepEqual(requests, [
    {
      capabilities: [
        "file",
        "workspace-app",
        "workspace-issue",
        "agent-target",
        "agent-session"
      ],
      surface: "desktop-workspace-root",
      target: "workspace",
      workspaceId: "workspace-1"
    }
  ]);
  service.dispose();
});

test("desktop mention service refreshes shared mounted consumers and releases event sources", async () => {
  let resolveCalls = 0;
  let sourceListener: (() => void) | undefined;
  let sourceUnsubscribeCalls = 0;
  const provider: RichTextTriggerProvider = {
    id: "workspace-app",
    trigger: "@",
    query: () => [],
    getItemKey: () => "",
    getItemLabel: () => "",
    toInsertResult: () => ({ kind: "text", text: "" }),
    resolveMention: async () => {
      resolveCalls += 1;
      return {
        presentation: { iconUrl: `tutti://app-icon/canvas-${resolveCalls}` }
      };
    }
  };
  const service = createDesktopRichTextMentionService({
    invalidationSources: [
      {
        selector: {
          providerId: "workspace-app",
          workspaceId: "workspace-1"
        },
        subscribe(listener) {
          sourceListener = listener;
          return () => {
            sourceUnsubscribeCalls += 1;
          };
        }
      }
    ],
    richTextAtService: {
      _serviceBrand: undefined,
      getProviders: () => [provider]
    },
    workspaceId: "workspace-1"
  });
  const identity = {
    providerId: "workspace-app",
    entityId: "canvas",
    label: "Canvas",
    scope: { workspaceId: "workspace-1" }
  };
  const consumerNotifications = [0, 0, 0];
  const unsubscribeConsumers = consumerNotifications.map((_, index) =>
    service.subscribe(() => {
      consumerNotifications[index] = (consumerNotifications[index] ?? 0) + 1;
    }, identity)
  );

  await Promise.all([
    service.resolve(identity),
    service.resolve(identity),
    service.resolve(identity)
  ]);
  assert.equal(resolveCalls, 1);

  sourceListener?.();
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(resolveCalls, 2);
  assert.deepEqual(service.getSnapshot(identity).resolved?.presentation, {
    iconUrl: "tutti://app-icon/canvas-2"
  });
  assert.equal(
    consumerNotifications.every((count) => count > 0),
    true
  );

  for (const unsubscribe of unsubscribeConsumers) unsubscribe();
  service.dispose();
  service.dispose();
  assert.equal(sourceUnsubscribeCalls, 1);
});
