import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { workspaceAppManifestSchemaVersion } from "../contracts/manifest.ts";
import { validateWorkspaceAppManifest } from "./manifestValidation.ts";

describe("validateWorkspaceAppManifest", () => {
  it("normalizes a valid manifest without host paths", () => {
    const result = validateWorkspaceAppManifest({
      schemaVersion: workspaceAppManifestSchemaVersion,
      appId: "Demo.App",
      name: "Demo App",
      description: "Runs a demo workflow",
      icon: {
        type: "asset",
        src: "icon.png"
      },
      runtime: {
        bootstrap: "bootstrap.sh",
        healthcheckPath: "/"
      },
      tags: ["demo", "demo", "workspace"],
      version: "1.0.0"
    });

    assert.equal(result.valid, true);
    assert.equal(result.manifest?.appId, "demo.app");
    assert.deepEqual(result.manifest?.tags, ["demo", "workspace"]);
    assert.equal("appFolderPath" in (result.manifest ?? {}), false);
  });

  it("normalizes supported window minimize behavior", () => {
    const result = validateWorkspaceAppManifest({
      schemaVersion: workspaceAppManifestSchemaVersion,
      appId: "demo",
      name: "Demo",
      description: "Demo app",
      runtime: {
        bootstrap: "bootstrap.sh",
        healthcheckPath: "/"
      },
      version: "1.0.0",
      window: {
        minimizeBehavior: "hibernate"
      }
    });

    assert.equal(result.valid, true);
    assert.equal(result.manifest?.window?.minimizeBehavior, "hibernate");
  });

  it("normalizes supported window minimum size", () => {
    const result = validateWorkspaceAppManifest({
      schemaVersion: workspaceAppManifestSchemaVersion,
      appId: "demo",
      name: "Demo",
      description: "Demo app",
      runtime: {
        bootstrap: "bootstrap.sh",
        healthcheckPath: "/"
      },
      version: "1.0.0",
      window: {
        minHeight: 520,
        minWidth: 720
      }
    });

    assert.equal(result.valid, true);
    assert.equal(result.manifest?.window?.minHeight, 520);
    assert.equal(result.manifest?.window?.minWidth, 720);
  });

  it("normalizes reference list endpoint", () => {
    const result = validateWorkspaceAppManifest({
      schemaVersion: workspaceAppManifestSchemaVersion,
      appId: "demo",
      name: "Demo",
      description: "Demo app",
      runtime: {
        bootstrap: "bootstrap.sh",
        healthcheckPath: "/"
      },
      version: "1.0.0",
      references: {
        listEndpoint: "/references/list"
      }
    });

    assert.equal(result.valid, true);
    assert.deepEqual(result.manifest?.references, {
      listEndpoint: "/references/list"
    });
  });

  it("rejects invalid reference list endpoint", () => {
    const result = validateWorkspaceAppManifest({
      schemaVersion: workspaceAppManifestSchemaVersion,
      appId: "demo",
      name: "Demo",
      description: "Demo app",
      runtime: {
        bootstrap: "bootstrap.sh",
        healthcheckPath: "/"
      },
      version: "1.0.0",
      references: {
        listEndpoint: "/references/list?query=main"
      }
    });

    assert.equal(result.valid, false);
    assert.deepEqual(
      result.issues.map((issue) => issue.path),
      ["$.references.listEndpoint"]
    );
  });

  it("rejects unsupported reference endpoints", () => {
    const result = validateWorkspaceAppManifest({
      schemaVersion: workspaceAppManifestSchemaVersion,
      appId: "demo",
      name: "Demo",
      description: "Demo app",
      runtime: {
        bootstrap: "bootstrap.sh",
        healthcheckPath: "/"
      },
      version: "1.0.0",
      references: {
        listEndpoint: "/references/list",
        searchEndpoint: "/references/search"
      }
    });

    assert.equal(result.valid, false);
    assert.deepEqual(
      result.issues.map((issue) => issue.path),
      ["$.references.searchEndpoint"]
    );
  });

  it("rejects unsupported window minimize behavior", () => {
    const result = validateWorkspaceAppManifest({
      schemaVersion: workspaceAppManifestSchemaVersion,
      appId: "demo",
      name: "Demo",
      description: "Demo app",
      runtime: {
        bootstrap: "bootstrap.sh",
        healthcheckPath: "/"
      },
      version: "1.0.0",
      window: {
        minimizeBehavior: "destroy"
      }
    });

    assert.equal(result.valid, false);
    assert.deepEqual(
      result.issues.map((issue) => issue.path),
      ["$.window.minimizeBehavior"]
    );
  });

  it("rejects unsupported window minimum size", () => {
    const result = validateWorkspaceAppManifest({
      schemaVersion: workspaceAppManifestSchemaVersion,
      appId: "demo",
      name: "Demo",
      description: "Demo app",
      runtime: {
        bootstrap: "bootstrap.sh",
        healthcheckPath: "/"
      },
      version: "1.0.0",
      window: {
        minHeight: 159,
        minWidth: 720.5
      }
    });

    assert.equal(result.valid, false);
    assert.deepEqual(
      result.issues.map((issue) => issue.path),
      ["$.window.minWidth", "$.window.minHeight"]
    );
  });

  it("rejects unsupported schema versions and invalid ids", () => {
    const result = validateWorkspaceAppManifest({
      schemaVersion: "tutti.app.manifest.v0",
      appId: "bad id",
      name: "Bad App",
      description: "Bad",
      runtime: {
        bootstrap: "bootstrap.sh",
        healthcheckPath: "/"
      },
      version: "0.1.0"
    });

    assert.equal(result.valid, false);
    assert.deepEqual(
      result.issues.map((issue) => issue.code),
      ["manifest.schemaVersion", "manifest.appId"]
    );
  });

  it("requires app runtime paths without host absolute paths", () => {
    const result = validateWorkspaceAppManifest({
      schemaVersion: workspaceAppManifestSchemaVersion,
      appId: "demo",
      name: "Demo",
      description: "Demo app",
      runtime: {
        bootstrap: "/tmp/bootstrap.sh",
        healthcheckPath: "healthz"
      },
      version: "1.0.0"
    });

    assert.equal(result.valid, false);
    assert.deepEqual(
      result.issues.map((issue) => issue.path),
      ["$.runtime.bootstrap", "$.runtime.healthcheckPath"]
    );
  });
});
