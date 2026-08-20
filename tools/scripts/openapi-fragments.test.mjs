import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeOpenApiFragmentRefs,
  resolveOpenApiFragmentPath
} from "./openapi-fragments.mjs";

const extensionKey = "x-tutti-openapi-fragments";

test("normalizes repository and package fragment references", () => {
  assert.deepEqual(
    normalizeOpenApiFragmentRefs(
      [
        "packages/workspace/issue-manager/openapi/issue-manager.v1.yaml",
        {
          package: "@tutti-os/connector-contracts",
          path: "openapi/connector-market.v1.yaml"
        }
      ],
      extensionKey
    ),
    [
      "packages/workspace/issue-manager/openapi/issue-manager.v1.yaml",
      {
        package: "@tutti-os/connector-contracts",
        path: "openapi/connector-market.v1.yaml"
      }
    ]
  );
});

test("resolves package fragments through package exports", () => {
  const resolved = resolveOpenApiFragmentPath(
    {
      package: "@tutti-os/connector-contracts",
      path: "openapi/connector-market.v1.yaml"
    },
    {
      repoRoot: "/repo",
      specPath: "/repo/services/daemon/openapi.yaml",
      resolvePackageSpecifier(specifier) {
        assert.equal(
          specifier,
          "@tutti-os/connector-contracts/openapi/connector-market.v1.yaml"
        );
        return "/node_modules/@tutti-os/connector-contracts/openapi/connector-market.v1.yaml";
      }
    }
  );
  assert.equal(
    resolved,
    "/node_modules/@tutti-os/connector-contracts/openapi/connector-market.v1.yaml"
  );
});

test("rejects package paths that escape the package export boundary", () => {
  assert.throws(
    () =>
      normalizeOpenApiFragmentRefs(
        [{ package: "@tutti-os/connector-contracts", path: "../private.yaml" }],
        extensionKey
      ),
    /package-relative/
  );
});
