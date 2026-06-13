import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";
import { buildTuttiAppRuntimeCatalog } from "./build-tutti-app-runtime-catalog.mjs";

const runtimeWorkflowPath = new URL(
  "../../.github/workflows/publish-tutti-app-runtime.yml",
  import.meta.url
);

test("buildTuttiAppRuntimeCatalog writes runtime catalog from artifact metadata", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "tutti-runtime-catalog-"));
  const darwin = await runtimeMetadataFile(tempDir, {
    platform: "darwin-arm64",
    components: {
      python: {
        artifactPath:
          "2026.06.0/darwin-arm64/python/tutti-app-runtime-python-darwin-arm64-2026.06.0.zip",
        artifactSha256: "a".repeat(64)
      }
    },
    profiles: {
      baseline: ["python"]
    }
  });
  const linux = await runtimeMetadataFile(tempDir, {
    platform: "linux-amd64",
    components: {
      node: {
        artifactPath:
          "2026.06.0/linux-amd64/node/tutti-app-runtime-node-linux-amd64-2026.06.0.zip",
        artifactSha256: "b".repeat(64)
      }
    },
    profiles: {
      baseline: ["node"]
    }
  });
  const output = path.join(tempDir, "catalog.json");

  const catalog = await buildTuttiAppRuntimeCatalog({
    artifactBaseUrl: "https://cdn.example.test/app-runtimes/",
    metadataFiles: [linux, darwin],
    output
  });

  assert.deepEqual(Object.keys(catalog.runtimes), [
    "darwin-arm64",
    "linux-amd64"
  ]);
  assert.deepEqual(JSON.parse(await readFile(output, "utf8")), catalog);
  assert.equal(
    catalog.runtimes["darwin-arm64"].components.python.artifactUrl,
    "https://cdn.example.test/app-runtimes/2026.06.0/darwin-arm64/python/tutti-app-runtime-python-darwin-arm64-2026.06.0.zip"
  );
  assert.deepEqual(catalog.runtimes["darwin-arm64"].profiles.baseline, [
    "python"
  ]);
});

test("buildTuttiAppRuntimeCatalog rejects duplicate platforms", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "tutti-runtime-catalog-"));
  const first = await runtimeMetadataFile(tempDir, {
    platform: "darwin-arm64",
    components: {
      python: {
        artifactPath: "2026.06.0/darwin-arm64/python/first.zip",
        artifactSha256: "a".repeat(64)
      }
    },
    profiles: {
      baseline: ["python"]
    }
  });
  const second = await runtimeMetadataFile(tempDir, {
    platform: "darwin-arm64",
    components: {
      python: {
        artifactPath: "2026.06.0/darwin-arm64/python/second.zip",
        artifactSha256: "b".repeat(64)
      }
    },
    profiles: {
      baseline: ["python"]
    }
  });

  await assert.rejects(
    () =>
      buildTuttiAppRuntimeCatalog({
        artifactBaseUrl: "https://cdn.example.test/app-runtimes",
        metadataFiles: [first, second],
        output: path.join(tempDir, "catalog.json")
      }),
    /duplicate runtime platform darwin-arm64/
  );
});

test("Tutti app runtime workflow publishes immutable artifacts and mutable catalog", async () => {
  const workflow = await readFile(runtimeWorkflowPath, "utf8");

  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /config\/tutti\.app-runtime\.lock\.json/);
  assert.match(workflow, /uv python install --no-bin "\$\{PYTHON_VERSION\}"/);
  assert.match(workflow, /SHASUMS256\.txt/);
  assert.match(
    workflow,
    /tutti-app-runtime-python-\$\{PLATFORM\}-\$\{RUNTIME_VERSION\}\.zip/
  );
  assert.match(
    workflow,
    /tutti-app-runtime-node-\$\{PLATFORM\}-\$\{RUNTIME_VERSION\}\.zip/
  );
  assert.match(workflow, /node\/bin\/npm/);
  assert.match(workflow, /npm-cli\.js/);
  assert.match(workflow, /node\/bin\/npx/);
  assert.match(workflow, /npx-cli\.js/);
  assert.match(workflow, /\$\{node_staging\}\/node\/bin\/npm" --version/);
  assert.match(workflow, /\$\{node_staging\}\/node\/bin\/npx" --version/);
  assert.match(workflow, /path: downloaded-tutti-app-runtime/);
  assert.match(workflow, /merge-multiple: false/);
  assert.match(workflow, /Restore runtime artifact layout/);
  assert.match(
    workflow,
    /target_dir="tutti-app-runtime\/\$\{runtime_version\}\/\$\{platform\}"/
  );
  assert.match(workflow, /build-tutti-app-runtime-catalog\.mjs/);
  assert.match(workflow, /max-age=31536000, immutable/);
  assert.match(workflow, /max-age=60/);
});

test("Tutti app runtime workflow falls back to legacy Nextop GitHub variables", async () => {
  const workflow = await readFile(runtimeWorkflowPath, "utf8");

  assert.match(
    workflow,
    /AWS_REGION_VALUE:\s+\${{\s*inputs\.aws_region\s*\|\|\s*vars\.TUTTI_APP_RUNTIME_AWS_REGION\s*\|\|\s*vars\.NEXTOP_APP_RUNTIME_AWS_REGION\s*\|\|\s*vars\.TUTTI_APP_RELEASES_AWS_REGION\s*\|\|\s*vars\.NEXTOP_APP_RELEASES_AWS_REGION\s*}}/
  );
  assert.match(
    workflow,
    /AWS_ROLE_ARN_VALUE:\s+\${{\s*inputs\.aws_role_arn\s*\|\|\s*vars\.TUTTI_APP_RUNTIME_AWS_ROLE_ARN\s*\|\|\s*vars\.NEXTOP_APP_RUNTIME_AWS_ROLE_ARN\s*\|\|\s*vars\.TUTTI_APP_RELEASES_AWS_ROLE_ARN\s*\|\|\s*vars\.NEXTOP_APP_RELEASES_AWS_ROLE_ARN\s*}}/
  );
  assert.match(
    workflow,
    /S3_BUCKET_VALUE:\s+\${{\s*inputs\.s3_bucket\s*\|\|\s*vars\.TUTTI_APP_RUNTIME_S3_BUCKET\s*\|\|\s*vars\.NEXTOP_APP_RUNTIME_S3_BUCKET\s*\|\|\s*vars\.TUTTI_APP_RELEASES_S3_BUCKET\s*\|\|\s*vars\.NEXTOP_APP_RELEASES_S3_BUCKET\s*}}/
  );
  assert.match(
    workflow,
    /S3_PREFIX_VALUE:\s+\${{\s*inputs\.s3_prefix\s*\|\|\s*vars\.TUTTI_APP_RUNTIME_S3_PREFIX\s*\|\|\s*vars\.NEXTOP_APP_RUNTIME_S3_PREFIX\s*\|\|\s*'tutti-app-runtimes'\s*}}/
  );
  assert.match(
    workflow,
    /ARTIFACT_BASE_URL_VALUE:\s+\${{\s*inputs\.artifact_base_url\s*\|\|\s*vars\.TUTTI_APP_RUNTIME_ARTIFACT_BASE_URL\s*\|\|\s*vars\.NEXTOP_APP_RUNTIME_ARTIFACT_BASE_URL\s*}}/
  );
  assert.match(
    workflow,
    /CLOUDFRONT_DISTRIBUTION_ID_VALUE:\s+\${{\s*inputs\.cloudfront_distribution_id\s*\|\|\s*vars\.TUTTI_APP_RUNTIME_CLOUDFRONT_DISTRIBUTION_ID\s*\|\|\s*vars\.NEXTOP_APP_RUNTIME_CLOUDFRONT_DISTRIBUTION_ID\s*}}/
  );
});

async function runtimeMetadataFile(tempDir, overrides) {
  const baseMetadata = {
    schemaVersion: "tutti.app.runtime-platform.v2",
    runtimeVersion: "2026.06.0",
    platform: "darwin-arm64",
    pythonVersion: "3.12.13",
    nodeVersion: "22.22.3",
    components: {
      python: {
        version: "3.12.13",
        artifactPath:
          "2026.06.0/darwin-arm64/python/tutti-app-runtime-python-darwin-arm64-2026.06.0.zip",
        artifactSha256: "a".repeat(64),
        artifactSizeBytes: 123
      },
      node: {
        version: "22.22.3",
        artifactPath:
          "2026.06.0/darwin-arm64/node/tutti-app-runtime-node-darwin-arm64-2026.06.0.zip",
        artifactSha256: "b".repeat(64),
        artifactSizeBytes: 456
      }
    },
    profiles: {
      baseline: ["python", "node"]
    }
  };
  const metadata = {
    ...baseMetadata,
    ...overrides
  };
  if (overrides.components) {
    metadata.components = Object.fromEntries(
      Object.entries(overrides.components).map(([name, component]) => [
        name,
        {
          ...baseMetadata.components[name],
          version:
            component.version ??
            (name === "node"
              ? baseMetadata.nodeVersion
              : baseMetadata.pythonVersion),
          artifactSizeBytes: component.artifactSizeBytes ?? 123,
          ...component
        }
      ])
    );
  }
  const filePath = path.join(
    tempDir,
    `${metadata.platform}-${Math.random()}.json`
  );
  await writeFile(filePath, `${JSON.stringify(metadata, null, 2)}\n`);
  return filePath;
}
