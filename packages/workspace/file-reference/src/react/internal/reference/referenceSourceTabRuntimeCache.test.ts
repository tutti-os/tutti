import assert from "node:assert/strict";
import { test } from "node:test";

import type { ReferenceSourceAggregator } from "../../../core/referenceSourceAggregator.ts";
import {
  invalidateReferenceSourcePickerRuntimeCache,
  invalidateReferenceSourceTabRuntimeCache,
  readReferenceSourceTabRuntimeCache,
  writeReferenceSourceTabRuntimeCache
} from "./referenceSourceTabRuntimeCache.ts";

test("tab runtime cache is isolated by aggregator and workspace", () => {
  const firstAggregator = {} as ReferenceSourceAggregator;
  const secondAggregator = {} as ReferenceSourceAggregator;
  const tabs = [
    {
      sourceId: "workspace-file",
      label: "Workspace",
      capabilities: {
        paginated: false,
        previewable: true,
        searchable: true
      }
    }
  ];

  writeReferenceSourceTabRuntimeCache(firstAggregator, "workspace-1", tabs);

  assert.equal(
    readReferenceSourceTabRuntimeCache(firstAggregator, "workspace-1"),
    tabs
  );
  assert.deepEqual(
    readReferenceSourceTabRuntimeCache(firstAggregator, "workspace-2"),
    []
  );
  assert.deepEqual(
    readReferenceSourceTabRuntimeCache(secondAggregator, "workspace-1"),
    []
  );

  invalidateReferenceSourceTabRuntimeCache(firstAggregator, "workspace-1");
  assert.deepEqual(
    readReferenceSourceTabRuntimeCache(firstAggregator, "workspace-1"),
    []
  );
});

test("picker runtime invalidation clears tabs and active reads together", () => {
  let invalidatedWorkspaceId: string | undefined;
  const aggregator = {
    invalidateRuntimeReads(scope?: { workspaceId: string }) {
      invalidatedWorkspaceId = scope?.workspaceId;
    }
  } as ReferenceSourceAggregator;
  writeReferenceSourceTabRuntimeCache(aggregator, "workspace-1", []);

  invalidateReferenceSourcePickerRuntimeCache(aggregator, "workspace-1");

  assert.deepEqual(
    readReferenceSourceTabRuntimeCache(aggregator, "workspace-1"),
    []
  );
  assert.equal(invalidatedWorkspaceId, "workspace-1");
});
