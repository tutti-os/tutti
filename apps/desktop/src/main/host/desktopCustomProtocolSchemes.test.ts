import assert from "node:assert/strict";
import test from "node:test";
import { tuttiAssetProtocolScheme } from "../../shared/tuttiAssetProtocol.ts";
import { desktopCustomProtocolSchemes } from "./desktopCustomProtocolSchemes.ts";
import { workspaceFileIconProtocolScheme } from "./workspaceFileIconCacheStore.ts";

test("desktop image protocols support cross-origin renderer fetch", () => {
  for (const scheme of [
    tuttiAssetProtocolScheme,
    workspaceFileIconProtocolScheme
  ]) {
    const definition = desktopCustomProtocolSchemes.find(
      (candidate) => candidate.scheme === scheme
    );

    assert.equal(definition?.privileges?.supportFetchAPI, true);
    assert.equal(definition?.privileges?.corsEnabled, true);
  }
});
