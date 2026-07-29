import { expect, it } from "vitest";
import type {
  RichTextMentionInvalidationSelector,
  RichTextMentionService,
  RichTextMentionSnapshot
} from "@tutti-os/ui-rich-text/service";
import type {
  RichTextMentionIdentity,
  RichTextTriggerProvider
} from "@tutti-os/ui-rich-text/types";
import { composeAgentGUIMentionService } from "./composeAgentGUIMentionService";

it("preserves inherited resolution authority", async () => {
  const inherited = createServiceProbe([createProvider("file")]);
  const surface = createServiceProbe([
    createProvider("file"),
    createProvider("agent-generated-file")
  ]);
  const service = composeAgentGUIMentionService({
    inheritedService: inherited.service,
    surfaceService: surface.service
  });
  const fileIdentity = createIdentity("file");
  const generatedFileIdentity = createIdentity("agent-generated-file");

  expect(service.listProviders().map((provider) => provider.id)).toEqual([
    "file",
    "agent-generated-file"
  ]);
  await service.resolve(fileIdentity);
  service.getSnapshot(fileIdentity);
  const unsubscribeFile = service.subscribe(() => {}, fileIdentity);
  await service.resolve(generatedFileIdentity);
  service.getSnapshot(generatedFileIdentity);
  const unsubscribeGeneratedFile = service.subscribe(
    () => {},
    generatedFileIdentity
  );

  expect(inherited.calls).toEqual([
    "resolve:file",
    "getSnapshot:file",
    "subscribe:file"
  ]);
  expect(surface.calls).toEqual([
    "resolve:agent-generated-file",
    "getSnapshot:agent-generated-file",
    "subscribe:agent-generated-file"
  ]);
  unsubscribeFile();
  unsubscribeGeneratedFile();
});

it("invalidates both owned provider sets", () => {
  const inherited = createServiceProbe([createProvider("file")]);
  const surface = createServiceProbe([createProvider("agent-generated-file")]);
  const service = composeAgentGUIMentionService({
    inheritedService: inherited.service,
    surfaceService: surface.service
  });
  const selector = { workspaceId: "workspace-1" };

  service.invalidate(selector);

  expect(inherited.invalidations).toEqual([selector]);
  expect(surface.invalidations).toEqual([selector]);
});

function createProvider(id: string): RichTextTriggerProvider {
  return {
    id,
    trigger: "@",
    getItemKey: () => id,
    getItemLabel: () => id,
    query: () => [],
    toInsertResult: () => ({ kind: "text", text: id })
  };
}

function createIdentity(providerId: string): RichTextMentionIdentity {
  return {
    entityId: `${providerId}-entity`,
    label: providerId,
    providerId
  };
}

function createServiceProbe(providers: readonly RichTextTriggerProvider[]): {
  calls: string[];
  invalidations: Array<RichTextMentionInvalidationSelector | undefined>;
  service: RichTextMentionService;
} {
  const calls: string[] = [];
  const invalidations: Array<RichTextMentionInvalidationSelector | undefined> =
    [];
  const snapshot: RichTextMentionSnapshot = { state: "idle" };
  const service: RichTextMentionService = {
    listProviders: () => providers,
    getProvider: (providerId) =>
      providers.find((provider) => provider.id === providerId),
    listTriggerConfigs: () => [],
    query: async () => [],
    async resolve(identity) {
      calls.push(`resolve:${identity.providerId}`);
      return snapshot;
    },
    getSnapshot(identity) {
      calls.push(`getSnapshot:${identity.providerId}`);
      return snapshot;
    },
    invalidate(selector) {
      invalidations.push(selector);
    },
    subscribe(_listener, identity) {
      calls.push(`subscribe:${identity?.providerId ?? "*"}`);
      return () => {};
    },
    dispose() {}
  };
  return { calls, invalidations, service };
}
