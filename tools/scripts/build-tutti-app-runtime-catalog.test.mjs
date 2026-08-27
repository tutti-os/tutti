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
const runtimeLockPath = new URL(
  "../../config/tutti.app-runtime.lock.json",
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
      baseline: ["node"],
      "node-static": ["node"]
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
  assert.deepEqual(catalog.runtimes["linux-amd64"].profiles["node-static"], [
    "node"
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
  assert.match(workflow, /push:\s*\n\s*branches:\s*\n\s*- main/);
  assert.match(
    workflow,
    /paths:\s*\n\s*- config\/tutti\.app-runtime\.lock\.json/
  );
  assert.match(workflow, /group: tutti-app-runtime-production/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /config\/tutti\.app-runtime\.lock\.json/);
  assert.match(workflow, /platform === "windows-amd64"/);
  assert.match(workflow, /lock\.python\?\.windows\?\.version/);
  assert.match(workflow, /uv python install --no-bin "\$\{PYTHON_VERSION\}"/);
  assert.match(workflow, /python-\$env:PYTHON_VERSION-embed-amd64\.zip/);
  assert.match(workflow, /PYTHON_WINDOWS_ARCHIVE_SHA256/);
  assert.match(workflow, /Expand-Archive -LiteralPath \$archivePath/);
  assert.match(workflow, /Get-AuthenticodeSignature/);
  assert.match(workflow, /O=Python Software Foundation/);
  assert.match(workflow, /\.Extension -in '\.exe', '\.dll', '\.pyd'/);
  assert.match(workflow, /SHASUMS256\.txt/);
  assert.match(
    workflow,
    /tutti-app-runtime-python-\$\{PLATFORM\}-\$\{RUNTIME_VERSION\}\.zip/
  );
  assert.match(
    workflow,
    /tutti-app-runtime-node-\$\{PLATFORM\}-\$\{RUNTIME_VERSION\}\.zip/
  );
  assert.match(
    workflow,
    /tutti-app-runtime-rtk-\$\{PLATFORM\}-\$\{RUNTIME_VERSION\}\.zip/
  );
  assert.match(workflow, /node\/bin\/npm/);
  assert.match(workflow, /npm-cli\.js/);
  assert.match(workflow, /node\/bin\/npx/);
  assert.match(workflow, /npx-cli\.js/);
  assert.match(workflow, /node\/bin\/corepack/);
  assert.match(workflow, /corepack\/dist\/corepack\.js/);
  assert.match(workflow, /\$\{node_staging\}\/node\/bin\/npm" --version/);
  assert.match(workflow, /"node-static": \["node"\]/);
  assert.match(workflow, /"rtk-saver": \["rtk"\]/);
  assert.match(workflow, /baseline = @\('python', 'node'\)/);
  assert.match(workflow, /'rtk-saver' = @\('rtk'\)/);
  assert.match(workflow, /RTK_ARCHIVE_SHA256/);
  assert.match(workflow, /RTK_LICENSE_SHA256/);
  assert.match(workflow, /\$\{node_staging\}\/node\/bin\/npx" --version/);
  assert.match(workflow, /\$\{node_staging\}\/node\/bin\/corepack" --version/);
  assert.match(workflow, /path: downloaded-tutti-app-runtime/);
  assert.match(workflow, /merge-multiple: false/);
  assert.match(workflow, /Restore runtime artifact layout/);
  assert.match(
    workflow,
    /target_dir="tutti-app-runtime\/\$\{runtime_version\}\/\$\{platform\}"/
  );
  assertAwsValidationBeforeConfigure(workflow, [
    "AWS_REGION_VALUE",
    "AWS_ROLE_ARN_VALUE",
    "S3_BUCKET_VALUE",
    "ARTIFACT_BASE_URL_VALUE"
  ]);
  assert.match(workflow, /build-tutti-app-runtime-catalog\.mjs/);
  assert.match(workflow, /max-age=31536000, immutable/);
  assert.match(workflow, /max-age=60/);
});

test("Windows runtime pins the official signed CPython 3.12.10 embeddable package", async () => {
  const lock = JSON.parse(await readFile(runtimeLockPath, "utf8"));

  assert.equal(lock.python.version, "3.12.13");
  assert.equal(lock.python.windows.version, "3.12.10");
  assert.equal(
    lock.python.windows.archiveUrl,
    "https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip"
  );
  assert.equal(
    lock.python.windows.archiveSha256,
    "4acbed6dd1c744b0376e3b1cf57ce906f9dc9e95e68824584c8099a63025a3c3"
  );
});

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
