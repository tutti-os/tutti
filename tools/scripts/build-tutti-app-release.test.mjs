import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, chmod, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  buildTuttiAppRelease,
  validateCLIManifest,
  validateManifest
} from "./build-tutti-app-release.mjs";
import { buildTuttiAppCatalog } from "./build-tutti-app-catalog.mjs";
import { verifyTuttiAppReleaseArtifacts } from "../../packages/workspace/app-release-tools/bin/verify-tutti-app-release-artifacts.mjs";

const reusableWorkflowPath = new URL(
  "../../.github/workflows/publish-tutti-app-release.yml",
  import.meta.url
);
const catalogWorkflowPath = new URL(
  "../../.github/workflows/publish-tutti-app-catalog.yml",
  import.meta.url
);
const stagingCatalogWorkflowPath = new URL(
  "../../.github/workflows/publish-tutti-app-catalog-staging.yml",
  import.meta.url
);
const releaseReferencePath = new URL(
  "../../services/tuttid/service/workspace/agent_workspace_app_reference/references/github-actions-release.md",
  import.meta.url
);

test("buildTuttiAppRelease writes immutable release and latest metadata", async () => {
  const packageDir = await createPackageForTest("vibe-design");
  const outputDir = await mkdtemp(path.join(tmpdir(), "tutti-release-"));

  const result = await buildTuttiAppRelease({
    appId: "vibe-design",
    packageDir,
    outputDir,
    baseUrl: "https://cdn.example.test/tutti-apps/",
    version: "0.1.0+abc123",
    gitSha: "abc123",
    publishedAt: "2026-06-04T00:00:00Z"
  });

  assert.equal(result.release.appId, "vibe-design");
  assert.equal(result.release.version, "0.1.0+abc123");
  assert.equal(result.release.manifest.version, "0.1.0+abc123");
  assert.deepEqual(result.release.manifest.authors, [
    {
      name: "Tutti Developer",
      avatarUrl: "https://github.com/tutti-os.png",
      url: "https://github.com/tutti-os"
    }
  ]);
  assert.deepEqual(result.release.manifest.source, {
    type: "github",
    url: "https://github.com/tutti-os/vibe-design"
  });
  assert.equal(
    result.release.artifactUrl,
    "https://cdn.example.test/tutti-apps/apps/vibe-design/0.1.0%2Babc123/vibe-design-0.1.0%2Babc123.zip"
  );
  assert.match(result.release.artifactSha256, /^[a-f0-9]{64}$/);
  assert.ok(result.release.artifactSizeBytes > 0);
  assert.equal(
    result.release.iconUrl,
    "https://cdn.example.test/tutti-apps/apps/vibe-design/0.1.0%2Babc123/icon.svg"
  );

  const latest = JSON.parse(await readFile(result.latestJsonPath, "utf8"));
  assert.deepEqual(latest, result.release);

  const manifest = JSON.parse(
    await readFile(path.join(packageDir, "tutti.app.json"), "utf8")
  );
  assert.equal(manifest.version, "0.1.0+abc123");
});

test("buildTuttiAppRelease includes package manifest localizations", async () => {
  const packageDir = await createPackageForTest("localized-app", {
    localizations: [
      {
        locale: "zh-CN",
        metadata: {
          name: "本地化应用",
          description: "本地化描述",
          tags: ["本地化", "工作区", "工作区"]
        }
      }
    ]
  });
  const outputDir = await mkdtemp(path.join(tmpdir(), "tutti-release-"));

  const result = await buildTuttiAppRelease({
    appId: "localized-app",
    packageDir,
    outputDir,
    baseUrl: "https://cdn.example.test/tutti-apps/",
    version: "0.1.0+abc123",
    gitSha: "abc123",
    publishedAt: "2026-06-04T00:00:00Z"
  });

  assert.deepEqual(result.release.localizations, [
    {
      locale: "zh-CN",
      name: "本地化应用",
      description: "本地化描述",
      tags: ["本地化", "工作区"]
    }
  ]);
});

test("buildTuttiAppCatalog merges release files into remote catalog", async () => {
  const alpha = await releaseFileForTest("alpha-app");
  const beta = await releaseFileForTest("beta-app", "0.1.0", {
    localizations: [
      {
        locale: "zh-CN",
        name: "Beta 应用",
        description: "Beta 描述",
        tags: ["Beta"]
      }
    ]
  });
  const outputDir = await mkdtemp(path.join(tmpdir(), "tutti-catalog-"));
  const outputPath = path.join(outputDir, "catalog.json");

  const result = await buildTuttiAppCatalog({
    releaseFiles: [beta, alpha],
    outputPath
  });

  assert.equal(result.catalog.schemaVersion, "tutti.app.catalog.v1");
  assert.deepEqual(
    result.catalog.apps.map((app) => app.manifest.appId),
    ["alpha-app", "beta-app"]
  );
  assert.equal(result.catalog.apps[0].distribution.kind, "remote");
  assert.equal(
    result.catalog.apps[0].distribution.iconUrl,
    "https://cdn.example.test/apps/alpha-app/icon.svg"
  );
  assert.deepEqual(result.catalog.apps[1].localizations, [
    {
      locale: "zh-CN",
      name: "Beta 应用",
      description: "Beta 描述",
      tags: ["Beta"]
    }
  ]);

  const written = JSON.parse(await readFile(outputPath, "utf8"));
  assert.deepEqual(written, result.catalog);
});

test("buildTuttiAppCatalog merges release files into an existing catalog", async () => {
  const alpha = await releaseFileForTest("alpha-app", "0.2.0");
  const existingCatalog = await catalogFileForTest([
    catalogAppForTest("alpha-app", "0.1.0"),
    catalogAppForTest("gamma-app", "0.1.0")
  ]);
  const outputDir = await mkdtemp(path.join(tmpdir(), "tutti-catalog-"));
  const outputPath = path.join(outputDir, "catalog.json");

  const result = await buildTuttiAppCatalog({
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

test("buildTuttiAppCatalog can refresh an existing catalog without release files", async () => {
  const existingCatalog = await catalogFileForTest([
    catalogAppForTest("gamma-app", "0.1.0"),
    catalogAppForTest("alpha-app", "0.1.0")
  ]);
  const outputDir = await mkdtemp(path.join(tmpdir(), "tutti-catalog-"));
  const outputPath = path.join(outputDir, "catalog.json");

  const result = await buildTuttiAppCatalog({
    existingCatalogPath: existingCatalog,
    releaseFiles: [],
    outputPath
  });

  assert.deepEqual(
    result.catalog.apps.map((app) => app.manifest.appId),
    ["alpha-app", "gamma-app"]
  );
});

test("buildTuttiAppCatalog rejects duplicate app ids", async () => {
  const first = await releaseFileForTest("duplicate-app");
  const second = await releaseFileForTest("duplicate-app");

  await assert.rejects(
    () =>
      buildTuttiAppCatalog({
        releaseFiles: [first, second],
        outputPath: path.join(tmpdir(), "unused-catalog.json")
      }),
    /duplicate release appId duplicate-app/
  );
});

test("verifyTuttiAppReleaseArtifacts validates release artifact hash and size", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "tutti-release-verify-"));
  const artifactPath = path.join(tempDir, "app.zip");
  const artifactBytes = Buffer.from("release artifact");
  await writeFile(artifactPath, artifactBytes);
  const releasePath = await releaseFileForTest("verified-app", "0.1.0", {
    artifactUrl: pathToFileURL(artifactPath).href,
    artifactSha256: createHash("sha256").update(artifactBytes).digest("hex"),
    artifactSizeBytes: artifactBytes.length
  });

  const result = await verifyTuttiAppReleaseArtifacts({
    releaseFiles: [releasePath]
  });

  assert.equal(result.checkedArtifactCount, 1);
});

test("verifyTuttiAppReleaseArtifacts rejects catalog artifact sha mismatches", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "tutti-catalog-verify-"));
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
      verifyTuttiAppReleaseArtifacts({
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
        schemaVersion: "tutti.app.manifest.v1",
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

test("validateManifest accepts references list endpoints", () => {
  const manifest = manifestForTest("references-app");
  manifest.references = { listEndpoint: "/references/list" };

  assert.doesNotThrow(() => validateManifest(manifest));
});

test("validateManifest accepts references search endpoints", () => {
  const manifest = manifestForTest("references-app");
  manifest.references = {
    listEndpoint: "/references/list",
    searchEndpoint: "/references/search"
  };

  assert.doesNotThrow(() => validateManifest(manifest));
});

test("validateManifest rejects unsupported references fields", () => {
  const manifest = manifestForTest("references-app");
  manifest.references = {
    listEndpoint: "/references/list",
    unknownEndpoint: "/references/unknown"
  };

  assert.throws(
    () => validateManifest(manifest),
    /references\.unknownEndpoint is unsupported/
  );
});

test("validateManifest rejects invalid references list endpoints", () => {
  for (const listEndpoint of [
    "references/list",
    "//example.test/references",
    "https://example.test/references",
    "/references?query=1",
    "/references#section"
  ]) {
    const manifest = manifestForTest("references-app");
    manifest.references = { listEndpoint };

    assert.throws(
      () => validateManifest(manifest),
      /references\.listEndpoint must be a relative URL path/
    );
  }
});

test("validateManifest rejects invalid references search endpoints", () => {
  for (const searchEndpoint of [
    "references/search",
    "//example.test/references",
    "https://example.test/references",
    "/references?query=1",
    "/references#section"
  ]) {
    const manifest = manifestForTest("references-app");
    manifest.references = { listEndpoint: "/references/list", searchEndpoint };

    assert.throws(
      () => validateManifest(manifest),
      /references\.searchEndpoint must be a relative URL path/
    );
  }
});

test("validateCLIManifest accepts the app CLI HTTP bridge contract", () => {
  assert.doesNotThrow(() =>
    validateCLIManifest(cliManifestForTest(), "tutti.cli.json")
  );
});

test("validateCLIManifest accepts typed input enum values", () => {
  const manifest = cliManifestForTest();
  manifest.commands[0].inputSchema.properties.mode = {
    type: "string",
    description: "Run mode",
    enum: ["fast", "safe"],
    default: "safe"
  };
  manifest.commands[0].inputSchema.properties.priority = {
    type: "integer",
    enum: [1, 2],
    default: 1
  };
  manifest.commands[0].inputSchema.properties.enabled = {
    type: "boolean",
    enum: [true],
    default: true
  };

  assert.doesNotThrow(() => validateCLIManifest(manifest, "tutti.cli.json"));
});

test("validateCLIManifest rejects enum values that do not match property type", () => {
  const manifest = cliManifestForTest();
  manifest.commands[0].inputSchema.properties.mode = {
    type: "string",
    enum: ["fast", 1]
  };

  assert.throws(
    () => validateCLIManifest(manifest, "tutti.cli.json"),
    /inputSchema\.properties\.mode\.enum\[1\] must be string/
  );
});

test("validateCLIManifest rejects defaults outside declared enum values", () => {
  const manifest = cliManifestForTest();
  manifest.commands[0].inputSchema.properties.mode = {
    type: "string",
    enum: ["fast", "safe"],
    default: "slow"
  };

  assert.throws(
    () => validateCLIManifest(manifest, "tutti.cli.json"),
    /inputSchema\.properties\.mode\.default must be one of the declared enum values/
  );
});

test("validateCLIManifest rejects invalid command visibility", () => {
  const manifest = cliManifestForTest();
  manifest.commands[0].visibility = "private";

  assert.throws(
    () => validateCLIManifest(manifest, "tutti.cli.json"),
    /visibility must be public or integration/
  );
});

test("buildTuttiAppRelease validates declared CLI manifests", async () => {
  const packageDir = await createPackageForTest("cli-app");
  const manifest = manifestForTest("cli-app");
  manifest.cli = { manifest: "tutti.cli.json" };
  await writeFile(
    path.join(packageDir, "tutti.app.json"),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
  await writeFile(
    path.join(packageDir, "tutti.cli.json"),
    `${JSON.stringify({ ...cliManifestForTest(), commands: [] }, null, 2)}\n`
  );
  const outputDir = path.join(
    await mkdtemp(path.join(tmpdir(), "tutti-release-")),
    "out"
  );

  await assert.rejects(
    () =>
      buildTuttiAppRelease({
        appId: "cli-app",
        packageDir,
        outputDir,
        baseUrl: "https://cdn.example.test/tutti-apps/"
      }),
    /commands must be a non-empty array/
  );
});

test("buildTuttiAppRelease rejects unsafe release path segments", async () => {
  const packageDir = await createPackageForTest("vibe-design");
  const outputDir = await mkdtemp(path.join(tmpdir(), "tutti-release-"));

  await assert.rejects(
    () =>
      buildTuttiAppRelease({
        appId: "vibe-design",
        packageDir,
        outputDir,
        baseUrl: "https://cdn.example.test/tutti-apps/",
        version: "0.1.0/abc123"
      }),
    /version must use only/
  );
});

test("Tutti app release workflow is reusable by external app repositories", async () => {
  const workflow = await readFile(reusableWorkflowPath, "utf8");

  assert.match(workflow, /workflow_call:/);
  assert.match(workflow, /release_tag_prefix:/);
  assert.match(workflow, /release_bump:/);
  assert.match(workflow, /create_release_tag:/);
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
  assert.match(workflow, /tutti-app-catalog-\{0\}-\{1\}/);
  assert.match(workflow, /tutti-app-release-\{0\}-\{1\}/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /\[skip release\]/);
  assert.match(workflow, /release_tools_package:/);
  assert.match(workflow, /default:\s+"@tutti-os\/app-release-tools@latest"/);
  assert.doesNotMatch(workflow, /auto_bump_version:/);
  assert.doesNotMatch(workflow, /version_bump:/);
  assert.doesNotMatch(workflow, /version_manifest_path:/);
  assert.doesNotMatch(workflow, /bump-tutti-app-version/);
  assert.doesNotMatch(workflow, /release_version:/);
  assert.doesNotMatch(workflow, /INPUT_RELEASE_VERSION/);
  assert.doesNotMatch(workflow, /Commit app version bump/);
  assert.doesNotMatch(workflow, /git push origin "HEAD:\$\{GITHUB_REF_NAME\}"/);
  assert.doesNotMatch(workflow, /REF_TYPE: \$\{\{ github\.ref_type \}\}/);
  assert.doesNotMatch(workflow, /github\.ref_type/);
  assert.match(workflow, /`\$\{process\.env\.APP_ID\}-v`/);
  assert.match(workflow, /git", \["fetch", "--tags", "--force"\]/);
  assert.match(workflow, /parseStableVersion/);
  assert.match(workflow, /nextVersionFromSources/);
  assert.match(workflow, /manifest\.version/);
  assert.match(workflow, /Package manifest version must be stable semver/);
  assert.match(
    workflow,
    /Resolved release version seed \$\{latest\.version\} from \$\{latest\.source\}/
  );
  assert.match(workflow, /release_bump requires create_release_tag/);
  assert.match(workflow, /create_release_tag requires release_bump/);
  assert.match(
    workflow,
    /releaseVersion = `\$\{manifest\.version\}\+\$\{gitSha\.slice\(0, 12\)\}`/
  );
  assert.match(workflow, /name: Create release tag/);
  assert.match(workflow, /git tag -a "\$\{RELEASE_TAG_NAME\}"/);
  assert.match(
    workflow,
    /git push origin "refs\/tags\/\$\{RELEASE_TAG_NAME\}"/
  );
  assert.match(
    workflow,
    /pnpm --package "\$\{RELEASE_TOOLS_PACKAGE\}" dlx build-tutti-app-release/
  );
  assert.doesNotMatch(workflow, /Checkout Tutti release tools/);
  assert.match(
    workflow,
    /aws s3 sync "tutti-app-release\/apps\/\$\{APP_ID\}\/\$\{RELEASE_VERSION\}\/"/
  );
  assert.match(
    workflow,
    /aws s3 cp "tutti-app-release\/apps\/\$\{APP_ID\}\/latest\.json"/
  );
  assert.match(workflow, /aws s3api head-object/);
  assert.match(workflow, /matching immutable metadata/);
  assert.match(workflow, /different immutable metadata/);
  assert.match(workflow, /Repairing mutable latest\/catalog state/);
  assert.match(workflow, /const comparedKeys = \[/);
  assert.match(workflow, /Verify published app release artifact/);
  assert.match(workflow, /verify-tutti-app-release-artifacts/);
  assert.match(
    workflow,
    /--release-file "tutti-app-release\/apps\/\$\{APP_ID\}\/latest\.json"/
  );
  assert.match(workflow, /Publish app catalog/);
  assert.match(workflow, /build-tutti-app-catalog/);
  assert.match(workflow, /CATALOG_ONLY:/);
  assert.match(workflow, /tutti-app-catalog\/releases\/\$\{APP_ID\}\.json/);
  assert.match(workflow, /apps\/\$\{APP_ID\}\/latest\.json/);
  assert.match(
    workflow,
    /--existing-catalog tutti-app-catalog\/existing-catalog\.json/
  );
  assert.match(workflow, /--release-file "\$\{release_file\}"/);
  assert.match(workflow, /aws s3 cp tutti-app-catalog\/catalog\.json/);
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
    /--existing-catalog tutti-app-releases\/existing-catalog\.json/
  );
  assert.match(workflow, /aws s3api head-object/);
  assert.match(workflow, /Refusing to publish a partial merge catalog/);
  assertCatalogWorkflowRefreshesExistingAppLatestMetadata(workflow);
  assert.match(workflow, /apps\/\$\{app_id\}\/latest\.json/);
  assert.match(workflow, /tools\/scripts\/build-tutti-app-catalog\.mjs/);
  assert.match(workflow, /Verify app catalog artifacts/);
  assertAwsValidationBeforeConfigure(workflow, [
    "AWS_REGION_VALUE",
    "AWS_ROLE_ARN_VALUE",
    "S3_BUCKET_VALUE"
  ]);
  assert.match(
    workflow,
    /packages\/workspace\/app-release-tools\/bin\/verify-tutti-app-release-artifacts\.mjs/
  );
  assert.match(workflow, /--catalog-file tutti-app-catalog\/catalog\.json/);
  assert.match(workflow, /aws s3 cp tutti-app-catalog\/catalog\.json/);
  assert.match(workflow, /cloudfront create-invalidation/);
});

test("Tutti app staging catalog workflow uses an isolated prefix", async () => {
  const workflow = await readFile(stagingCatalogWorkflowPath, "utf8");

  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /TUTTI_APP_RELEASES_STAGING_S3_PREFIX/);
  assert.match(workflow, /tutti-app-releases-staging/);
  assert.match(workflow, /catalog_mode:/);
  assert.doesNotMatch(workflow, /app_ids_preset/);
  assert.doesNotMatch(workflow, /APP_IDS_PRESET/);
  assert.match(
    workflow,
    /--existing-catalog tutti-app-releases\/existing-catalog\.json/
  );
  assert.match(workflow, /aws s3api head-object/);
  assert.match(workflow, /Refusing to publish a partial merge catalog/);
  assertCatalogWorkflowRefreshesExistingAppLatestMetadata(workflow);
  assert.match(workflow, /apps\/\$\{app_id\}\/latest\.json/);
  assert.match(workflow, /tools\/scripts\/build-tutti-app-catalog\.mjs/);
  assert.match(workflow, /Verify app catalog artifacts/);
  assertAwsValidationBeforeConfigure(workflow, [
    "AWS_REGION_VALUE",
    "AWS_ROLE_ARN_VALUE",
    "S3_BUCKET_VALUE"
  ]);
  assert.match(
    workflow,
    /packages\/workspace\/app-release-tools\/bin\/verify-tutti-app-release-artifacts\.mjs/
  );
  assert.match(workflow, /--catalog-file tutti-app-catalog\/catalog\.json/);
});

test("Tutti app staging release template requires an explicit staging asset base URL", async () => {
  const reference = await readFile(releaseReferencePath, "utf8");

  assert.match(reference, /TUTTI_APP_RELEASES_STAGING_BASE_URL/);
  assert.match(reference, /push:\n\s+branches:\n\s+- main/);
  assert.ok(
    reference.includes(
      "release_assets_base_url: ${{ vars.TUTTI_APP_RELEASES_STAGING_BASE_URL }}"
    )
  );
  assert.ok(
    reference.includes(
      "publish_catalog: ${{ github.event_name == 'push' || inputs.publish_catalog }}"
    )
  );
  assert.ok(
    reference.includes(
      "catalog_only: ${{ github.event_name == 'workflow_dispatch' && inputs.catalog_only }}"
    )
  );
  assert.doesNotMatch(
    reference,
    /TUTTI_APP_RELEASES_STAGING_BASE_URL \|\| vars\.TUTTI_APP_RELEASES_BASE_URL/
  );
  assert.match(
    reference,
    /private repositories that cannot read organization variables/
  );
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

function assertAwsValidationBeforeConfigure(workflow, names) {
  const validationIndex = workflow.indexOf("name: Validate AWS configuration");
  const configureIndex = workflow.indexOf("name: Configure AWS credentials");
  assert.notEqual(validationIndex, -1, "workflow should validate AWS config");
  assert.notEqual(configureIndex, -1, "workflow should configure AWS");
  assert.ok(
    validationIndex < configureIndex,
    "AWS validation must run before credentials configuration"
  );
  for (const name of names) {
    assert.match(workflow, new RegExp(`for name in[\\s\\S]*${name}`));
  }
  assert.match(workflow, /Missing required AWS configuration/);
}

async function releaseFileForTest(appId, version = "0.1.0", overrides = {}) {
  const tempDir = await mkdtemp(path.join(tmpdir(), "tutti-release-file-"));
  const release = {
    schemaVersion: "tutti.app.release.v1",
    appId,
    version,
    name: appId,
    description: `${appId} description`,
    manifest: manifestForTest(appId, version),
    ...(overrides.localizations
      ? { localizations: overrides.localizations }
      : {}),
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
  const tempDir = await mkdtemp(path.join(tmpdir(), "tutti-catalog-file-"));
  const catalogPath = path.join(tempDir, "catalog.json");
  await writeFile(
    catalogPath,
    `${JSON.stringify(
      {
        schemaVersion: "tutti.app.catalog.v1",
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

async function createPackageForTest(appId, options = {}) {
  const packageDir = await mkdtemp(path.join(tmpdir(), "tutti-app-package-"));
  await mkdir(path.join(packageDir, "web"), { recursive: true });
  const manifest = manifestForTest(appId);
  if (options.localizations?.length > 0) {
    manifest.localizationInfo = {
      defaultLocale: "en",
      additionalLocales: options.localizations.map((localization) => ({
        locale: localization.locale,
        file: `locales/${localization.locale}/manifest.json`
      }))
    };
  }
  await writeFile(
    path.join(packageDir, "tutti.app.json"),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
  for (const localization of options.localizations ?? []) {
    const localeDir = path.join(packageDir, "locales", localization.locale);
    await mkdir(localeDir, { recursive: true });
    await writeFile(
      path.join(localeDir, "manifest.json"),
      `${JSON.stringify(localization.metadata, null, 2)}\n`
    );
  }
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
    schemaVersion: "tutti.app.manifest.v1",
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
    },
    authors: [
      {
        name: "Tutti Developer",
        avatarUrl: "https://github.com/tutti-os.png",
        url: "https://github.com/tutti-os"
      }
    ],
    source: {
      type: "github",
      url: `https://github.com/tutti-os/${appId}`
    }
  };
}

function cliManifestForTest() {
  return {
    schemaVersion: "tutti.app.cli.v1",
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
          path: "/tutti/cli/run",
          timeoutMs: 30000
        }
      }
    ]
  };
}
