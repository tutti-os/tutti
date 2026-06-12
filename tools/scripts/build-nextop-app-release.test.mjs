import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, chmod, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  buildNextopAppRelease,
  validateCLIManifest,
  validateManifest
} from "./build-nextop-app-release.mjs";
import { buildNextopAppCatalog } from "./build-nextop-app-catalog.mjs";
import { bumpNextopAppVersion } from "../../packages/workspace/app-release-tools/bin/bump-nextop-app-version.mjs";
import { verifyNextopAppReleaseArtifacts } from "../../packages/workspace/app-release-tools/bin/verify-nextop-app-release-artifacts.mjs";

const reusableWorkflowPath = new URL(
  "../../.github/workflows/publish-nextop-app-release.yml",
  import.meta.url
);
const catalogWorkflowPath = new URL(
  "../../.github/workflows/publish-nextop-app-catalog.yml",
  import.meta.url
);
const stagingCatalogWorkflowPath = new URL(
  "../../.github/workflows/publish-nextop-app-catalog-staging.yml",
  import.meta.url
);

test("buildNextopAppRelease writes immutable release and latest metadata", async () => {
  const packageDir = await createPackageForTest("vibe-design");
  const outputDir = await mkdtemp(path.join(tmpdir(), "nextop-release-"));

  const result = await buildNextopAppRelease({
    appId: "vibe-design",
    packageDir,
    outputDir,
    baseUrl: "https://cdn.example.test/nextop-apps/",
    version: "0.1.0+abc123",
    gitSha: "abc123",
    publishedAt: "2026-06-04T00:00:00Z"
  });

  assert.equal(result.release.appId, "vibe-design");
  assert.equal(result.release.version, "0.1.0+abc123");
  assert.equal(result.release.manifest.version, "0.1.0+abc123");
  assert.equal(
    result.release.artifactUrl,
    "https://cdn.example.test/nextop-apps/apps/vibe-design/0.1.0%2Babc123/vibe-design-0.1.0%2Babc123.zip"
  );
  assert.match(result.release.artifactSha256, /^[a-f0-9]{64}$/);
  assert.ok(result.release.artifactSizeBytes > 0);
  assert.equal(
    result.release.iconUrl,
    "https://cdn.example.test/nextop-apps/apps/vibe-design/0.1.0%2Babc123/icon.svg"
  );

  const latest = JSON.parse(await readFile(result.latestJsonPath, "utf8"));
  assert.deepEqual(latest, result.release);

  const manifest = JSON.parse(
    await readFile(path.join(packageDir, "nextop.app.json"), "utf8")
  );
  assert.equal(manifest.version, "0.1.0+abc123");
});

test("buildNextopAppCatalog merges release files into remote catalog", async () => {
  const alpha = await releaseFileForTest("alpha-app");
  const beta = await releaseFileForTest("beta-app");
  const outputDir = await mkdtemp(path.join(tmpdir(), "nextop-catalog-"));
  const outputPath = path.join(outputDir, "catalog.json");

  const result = await buildNextopAppCatalog({
    releaseFiles: [beta, alpha],
    outputPath
  });

  assert.equal(result.catalog.schemaVersion, "nextop.app.catalog.v1");
  assert.deepEqual(
    result.catalog.apps.map((app) => app.manifest.appId),
    ["alpha-app", "beta-app"]
  );
  assert.equal(result.catalog.apps[0].distribution.kind, "remote");
  assert.equal(
    result.catalog.apps[0].distribution.iconUrl,
    "https://cdn.example.test/apps/alpha-app/icon.svg"
  );

  const written = JSON.parse(await readFile(outputPath, "utf8"));
  assert.deepEqual(written, result.catalog);
});

test("buildNextopAppCatalog merges release files into an existing catalog", async () => {
  const alpha = await releaseFileForTest("alpha-app", "0.2.0");
  const existingCatalog = await catalogFileForTest([
    catalogAppForTest("alpha-app", "0.1.0"),
    catalogAppForTest("gamma-app", "0.1.0")
  ]);
  const outputDir = await mkdtemp(path.join(tmpdir(), "nextop-catalog-"));
  const outputPath = path.join(outputDir, "catalog.json");

  const result = await buildNextopAppCatalog({
    existingCatalogPath: existingCatalog,
    releaseFiles: [alpha],
    outputPath
  });

  assert.deepEqual(
    result.catalog.apps.map((app) => app.manifest.appId),
    ["alpha-app", "gamma-app"]
  );
  assert.equal(result.catalog.apps[0].manifest.version, "0.2.0");
  assert.equal(result.catalog.apps[1].manifest.version, "0.1.0");
});

test("buildNextopAppCatalog can refresh an existing catalog without release files", async () => {
  const existingCatalog = await catalogFileForTest([
    catalogAppForTest("gamma-app", "0.1.0"),
    catalogAppForTest("alpha-app", "0.1.0")
  ]);
  const outputDir = await mkdtemp(path.join(tmpdir(), "nextop-catalog-"));
  const outputPath = path.join(outputDir, "catalog.json");

  const result = await buildNextopAppCatalog({
    existingCatalogPath: existingCatalog,
    releaseFiles: [],
    outputPath
  });

  assert.deepEqual(
    result.catalog.apps.map((app) => app.manifest.appId),
    ["alpha-app", "gamma-app"]
  );
});

test("buildNextopAppCatalog rejects duplicate app ids", async () => {
  const first = await releaseFileForTest("duplicate-app");
  const second = await releaseFileForTest("duplicate-app");

  await assert.rejects(
    () =>
      buildNextopAppCatalog({
        releaseFiles: [first, second],
        outputPath: path.join(tmpdir(), "unused-catalog.json")
      }),
    /duplicate release appId duplicate-app/
  );
});

test("bumpNextopAppVersion applies a stable semver patch bump", async () => {
  const packageDir = await createPackageForTest("bumped-app");
  const manifestPath = path.join(packageDir, "nextop.app.json");

  const result = await bumpNextopAppVersion({
    appId: "bumped-app",
    manifestPath,
    bump: "patch"
  });

  assert.equal(result.previousVersion, "0.1.0");
  assert.equal(result.version, "0.1.1");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(manifest.version, "0.1.1");
});

test("bumpNextopAppVersion rejects prerelease versions for automatic bumps", async () => {
  const packageDir = await createPackageForTest("bumped-app");
  const manifestPath = path.join(packageDir, "nextop.app.json");
  const manifest = manifestForTest("bumped-app", "0.1.0-beta.1");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  await assert.rejects(
    () =>
      bumpNextopAppVersion({
        appId: "bumped-app",
        manifestPath,
        bump: "patch"
      }),
    /stable semver x\.y\.z/
  );
});

test("verifyNextopAppReleaseArtifacts validates release artifact hash and size", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "nextop-release-verify-"));
  const artifactPath = path.join(tempDir, "app.zip");
  const artifactBytes = Buffer.from("release artifact");
  await writeFile(artifactPath, artifactBytes);
  const releasePath = await releaseFileForTest("verified-app", "0.1.0", {
    artifactUrl: pathToFileURL(artifactPath).href,
    artifactSha256: createHash("sha256").update(artifactBytes).digest("hex"),
    artifactSizeBytes: artifactBytes.length
  });

  const result = await verifyNextopAppReleaseArtifacts({
    releaseFiles: [releasePath]
  });

  assert.equal(result.checkedArtifactCount, 1);
});

test("verifyNextopAppReleaseArtifacts rejects catalog artifact sha mismatches", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "nextop-catalog-verify-"));
  const artifactPath = path.join(tempDir, "app.zip");
  const artifactBytes = Buffer.from("release artifact");
  await writeFile(artifactPath, artifactBytes);
  const releasePath = await releaseFileForTest("verified-app", "0.1.0", {
    artifactUrl: pathToFileURL(artifactPath).href,
    artifactSha256: createHash("sha256").update(artifactBytes).digest("hex"),
    artifactSizeBytes: artifactBytes.length
  });
  const catalogPath = await catalogFileForTest([
    catalogAppForTest("verified-app", "0.1.0", {
      artifactUrl: pathToFileURL(artifactPath).href,
      artifactSha256: "b".repeat(64)
    })
  ]);

  await assert.rejects(
    () =>
      verifyNextopAppReleaseArtifacts({
        catalogFile: catalogPath,
        releaseFiles: [releasePath]
      }),
    /artifactSha256 must match latest release metadata/
  );
});

test("validateManifest rejects packages without manifest icon assets", () => {
  assert.throws(
    () =>
      validateManifest({
        schemaVersion: "nextop.app.manifest.v1",
        appId: "bad-app",
        version: "0.1.0",
        name: "Bad App",
        description: "Bad app",
        runtime: {
          bootstrap: "bootstrap.sh",
          healthcheckPath: "/"
        }
      }),
    /icon is required/
  );
});

test("validateManifest accepts managed runtime manifests without launch metadata", () => {
  assert.doesNotThrow(() => validateManifest(manifestForTest("managed-app")));
});

test("validateCLIManifest accepts the app CLI HTTP bridge contract", () => {
  assert.doesNotThrow(() =>
    validateCLIManifest(cliManifestForTest(), "nextop.cli.json")
  );
});

test("buildNextopAppRelease validates declared CLI manifests", async () => {
  const packageDir = await createPackageForTest("cli-app");
  const manifest = manifestForTest("cli-app");
  manifest.cli = { manifest: "nextop.cli.json" };
  await writeFile(
    path.join(packageDir, "nextop.app.json"),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
  await writeFile(
    path.join(packageDir, "nextop.cli.json"),
    `${JSON.stringify({ ...cliManifestForTest(), commands: [] }, null, 2)}\n`
  );
  const outputDir = path.join(
    await mkdtemp(path.join(tmpdir(), "nextop-release-")),
    "out"
  );

  await assert.rejects(
    () =>
      buildNextopAppRelease({
        appId: "cli-app",
        packageDir,
        outputDir,
        baseUrl: "https://cdn.example.test/nextop-apps/"
      }),
    /commands must be a non-empty array/
  );
});

test("buildNextopAppRelease rejects unsafe release path segments", async () => {
  const packageDir = await createPackageForTest("vibe-design");
  const outputDir = await mkdtemp(path.join(tmpdir(), "nextop-release-"));

  await assert.rejects(
    () =>
      buildNextopAppRelease({
        appId: "vibe-design",
        packageDir,
        outputDir,
        baseUrl: "https://cdn.example.test/nextop-apps/",
        version: "0.1.0/abc123"
      }),
    /version must use only/
  );
});

test("Tutti app release workflow is reusable by external app repositories", async () => {
  const workflow = await readFile(reusableWorkflowPath, "utf8");

  assert.match(workflow, /workflow_call:/);
  assert.match(workflow, /contents: write/);
  assert.match(workflow, /auto_bump_version:/);
  assert.match(workflow, /version_bump:/);
  assert.match(workflow, /default: patch/);
  assert.match(workflow, /version_manifest_path:/);
  assert.match(workflow, /publish_catalog:/);
  assert.match(workflow, /catalog_only:/);
  assert.match(workflow, /catalog_cloudfront_distribution_id:/);
  assert.match(workflow, /Validate release inputs/);
  assert.match(
    workflow,
    /package_command is required unless catalog_only is true/
  );
  assert.match(
    workflow,
    /release_assets_base_url is required unless catalog_only is true/
  );
  assert.match(workflow, /concurrency:/);
  assert.match(workflow, /nextop-app-catalog-\{0\}-\{1\}/);
  assert.match(workflow, /nextop-app-release-\{0\}-\{1\}/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /\[skip release\]/);
  assert.match(workflow, /release_tools_package:/);
  assert.match(workflow, /default:\s+"@tutti-os\/app-release-tools@latest"/);
  assert.match(workflow, /Prepare release branch/);
  assert.match(
    workflow,
    /git checkout -B "\$\{REF_NAME\}" "origin\/\$\{REF_NAME\}"/
  );
  assert.match(workflow, /Bump app version/);
  assert.match(workflow, /bump-nextop-app-version/);
  assert.match(workflow, /Commit app version bump/);
  assert.match(workflow, /git push origin "HEAD:\$\{GITHUB_REF_NAME\}"/);
  assert.match(workflow, /release_version="\$\{manifest_version\}"/);
  assert.match(
    workflow,
    /release_version="\$\{manifest_version\}\+\$\{git_sha:0:12\}"/
  );
  assert.match(
    workflow,
    /pnpm --package "\$\{RELEASE_TOOLS_PACKAGE\}" dlx build-nextop-app-release/
  );
  assert.doesNotMatch(workflow, /Checkout Tutti release tools/);
  assert.match(
    workflow,
    /aws s3 sync "nextop-app-release\/apps\/\$\{APP_ID\}\/\$\{RELEASE_VERSION\}\/"/
  );
  assert.match(
    workflow,
    /aws s3 cp "nextop-app-release\/apps\/\$\{APP_ID\}\/latest\.json"/
  );
  assert.match(workflow, /aws s3api head-object/);
  assert.match(workflow, /matching immutable metadata/);
  assert.match(workflow, /different immutable metadata/);
  assert.match(workflow, /Repairing mutable latest\/catalog state/);
  assert.match(workflow, /const comparedKeys = \[/);
  assert.match(workflow, /Verify published app release artifact/);
  assert.match(workflow, /verify-nextop-app-release-artifacts/);
  assert.match(
    workflow,
    /--release-file "nextop-app-release\/apps\/\$\{APP_ID\}\/latest\.json"/
  );
  assert.match(workflow, /Publish app catalog/);
  assert.match(workflow, /build-nextop-app-catalog/);
  assert.match(workflow, /CATALOG_ONLY:/);
  assert.match(workflow, /nextop-app-catalog\/releases\/\$\{APP_ID\}\.json/);
  assert.match(workflow, /apps\/\$\{APP_ID\}\/latest\.json/);
  assert.match(
    workflow,
    /--existing-catalog nextop-app-catalog\/existing-catalog\.json/
  );
  assert.match(workflow, /--release-file "\$\{release_file\}"/);
  assert.match(workflow, /aws s3 cp nextop-app-catalog\/catalog\.json/);
  assert.match(workflow, /Invalidate app catalog/);
  assert.match(workflow, /cloudfront create-invalidation/);
});

test("Tutti app catalog workflow aggregates latest release metadata", async () => {
  const workflow = await readFile(catalogWorkflowPath, "utf8");

  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /catalog_mode:/);
  assert.match(workflow, /default:\s*merge/);
  assert.doesNotMatch(workflow, /app_ids_preset/);
  assert.doesNotMatch(workflow, /APP_IDS_PRESET/);
  assert.match(
    workflow,
    /--existing-catalog nextop-app-releases\/existing-catalog\.json/
  );
  assert.match(workflow, /aws s3api head-object/);
  assert.match(workflow, /Refusing to publish a partial merge catalog/);
  assertCatalogWorkflowRefreshesExistingAppLatestMetadata(workflow);
  assert.match(workflow, /apps\/\$\{app_id\}\/latest\.json/);
  assert.match(workflow, /tools\/scripts\/build-nextop-app-catalog\.mjs/);
  assert.match(workflow, /Verify app catalog artifacts/);
  assert.match(
    workflow,
    /packages\/workspace\/app-release-tools\/bin\/verify-nextop-app-release-artifacts\.mjs/
  );
  assert.match(workflow, /--catalog-file nextop-app-catalog\/catalog\.json/);
  assert.match(workflow, /aws s3 cp nextop-app-catalog\/catalog\.json/);
  assert.match(workflow, /cloudfront create-invalidation/);
});

test("Tutti app staging catalog workflow uses an isolated prefix", async () => {
  const workflow = await readFile(stagingCatalogWorkflowPath, "utf8");

  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /NEXTOP_APP_RELEASES_STAGING_S3_PREFIX/);
  assert.match(workflow, /nextop-app-releases-staging/);
  assert.match(workflow, /catalog_mode:/);
  assert.doesNotMatch(workflow, /app_ids_preset/);
  assert.doesNotMatch(workflow, /APP_IDS_PRESET/);
  assert.match(
    workflow,
    /--existing-catalog nextop-app-releases\/existing-catalog\.json/
  );
  assert.match(workflow, /aws s3api head-object/);
  assert.match(workflow, /Refusing to publish a partial merge catalog/);
  assertCatalogWorkflowRefreshesExistingAppLatestMetadata(workflow);
  assert.match(workflow, /apps\/\$\{app_id\}\/latest\.json/);
  assert.match(workflow, /tools\/scripts\/build-nextop-app-catalog\.mjs/);
  assert.match(workflow, /Verify app catalog artifacts/);
  assert.match(
    workflow,
    /packages\/workspace\/app-release-tools\/bin\/verify-nextop-app-release-artifacts\.mjs/
  );
  assert.match(workflow, /--catalog-file nextop-app-catalog\/catalog\.json/);
});

function assertCatalogWorkflowRefreshesExistingAppLatestMetadata(workflow) {
  assert.match(
    workflow,
    /\[ -z "\$\{app_ids_value\}" \] && \[ "\$\{CATALOG_MODE\}" = "merge" \]/
  );
  assert.match(workflow, /existing-catalog\.json/);
  assert.match(workflow, /manifest\??\.appId/);
  assert.match(workflow, /app_ids_value="\$\{existing_app_ids\}"/);
}

async function releaseFileForTest(appId, version = "0.1.0", overrides = {}) {
  const tempDir = await mkdtemp(path.join(tmpdir(), "nextop-release-file-"));
  const release = {
    schemaVersion: "nextop.app.release.v1",
    appId,
    version,
    name: appId,
    description: `${appId} description`,
    manifest: manifestForTest(appId, version),
    artifactUrl:
      overrides.artifactUrl ??
      `https://cdn.example.test/apps/${appId}/${appId}.zip`,
    artifactSha256: overrides.artifactSha256 ?? "a".repeat(64),
    artifactSizeBytes: overrides.artifactSizeBytes ?? 123,
    iconUrl: `https://cdn.example.test/apps/${appId}/icon.svg`,
    publishedAt: "2026-06-04T00:00:00Z",
    gitSha: "abc123"
  };
  const releasePath = path.join(tempDir, "release.json");
  await writeFile(releasePath, `${JSON.stringify(release, null, 2)}\n`);
  return releasePath;
}

async function catalogFileForTest(apps) {
  const tempDir = await mkdtemp(path.join(tmpdir(), "nextop-catalog-file-"));
  const catalogPath = path.join(tempDir, "catalog.json");
  await writeFile(
    catalogPath,
    `${JSON.stringify(
      {
        schemaVersion: "nextop.app.catalog.v1",
        apps
      },
      null,
      2
    )}\n`
  );
  return catalogPath;
}

function catalogAppForTest(appId, version, overrides = {}) {
  return {
    manifest: manifestForTest(appId, version),
    distribution: {
      kind: "remote",
      artifactUrl:
        overrides.artifactUrl ??
        `https://cdn.example.test/apps/${appId}/${appId}.zip`,
      artifactSha256: overrides.artifactSha256 ?? "b".repeat(64),
      iconUrl: `https://cdn.example.test/apps/${appId}/icon.svg`
    }
  };
}

async function createPackageForTest(appId) {
  const packageDir = await mkdtemp(path.join(tmpdir(), "nextop-app-package-"));
  await mkdir(path.join(packageDir, "web"), { recursive: true });
  await writeFile(
    path.join(packageDir, "nextop.app.json"),
    `${JSON.stringify(manifestForTest(appId), null, 2)}\n`
  );
  await writeFile(path.join(packageDir, "AGENTS.md"), "App instructions\n");
  await writeFile(path.join(packageDir, "icon.svg"), `<${"svg"}></${"svg"}>\n`);
  await writeFile(path.join(packageDir, "web", "index.html"), "<div></div>\n");
  const bootstrapPath = path.join(packageDir, "bootstrap.sh");
  await writeFile(bootstrapPath, "#!/usr/bin/env bash\nexit 0\n");
  await chmod(bootstrapPath, 0o755);
  return packageDir;
}

function manifestForTest(appId, version = "0.1.0") {
  return {
    schemaVersion: "nextop.app.manifest.v1",
    appId,
    version,
    name: appId,
    description: `${appId} description`,
    icon: {
      type: "asset",
      src: "icon.svg"
    },
    runtime: {
      bootstrap: "bootstrap.sh",
      healthcheckPath: "/"
    }
  };
}

function cliManifestForTest() {
  return {
    schemaVersion: "nextop.app.cli.v1",
    scope: "automation",
    commands: [
      {
        path: ["run"],
        summary: "Run automation",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string" },
            "dry-run": { type: "boolean" }
          },
          required: ["name"]
        },
        output: {
          defaultMode: "json",
          json: true
        },
        handler: {
          kind: "http",
          method: "POST",
          path: "/nextop/cli/run",
          timeoutMs: 30000
        }
      }
    ]
  };
}
